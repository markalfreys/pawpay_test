import { after, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { STALE_MS, SIGNAL_TTL_MS, REAP_INTERVAL_MS } from "@/lib/presence";
import { clientIp, LIMITS, rateLimit } from "@/lib/ratelimit";
import { getSession, unauthorized } from "@/lib/session";
import type { PollResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SignalRow = {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  payload: string | null;
  createdAt: Date;
};

// Per-instance throttle for garbage collection (see reap()).
let lastReapAt = 0;

// GET /api/poll — Authorization: Bearer <key>. The single endpoint that
// drives the live map. It (1) heartbeats the caller, (2) returns the filtered
// online peers, and (3) drains this user's mailbox. Stale rows are
// garbage-collected after the response is sent.
//
// The caller is identified by their secret key. It used to be `?id=`, the
// same public id every peer receives below, so anyone could drain anyone's
// mailbox and intercept their connection requests and SDP.
//
// The three queries are independent, so they run concurrently: one database
// round trip per poll instead of five sequential ones.
export async function GET(request: NextRequest) {
  const limited = rateLimit(`poll:${clientIp(request)}`, ...LIMITS.poll);
  if (limited) return limited;

  const session = getSession(request);
  if (!session) return unauthorized();
  const id = session.id;

  const now = Date.now();
  const staleCutoff = new Date(now - STALE_MS);

  const [heartbeat, peers, inbox] = await Promise.all([
    // 1) Heartbeat — refresh lastSeen for the caller ONLY. (This used to be
    // `where: {}`, which refreshed every row on every poll, so no dot ever
    // went stale and closed tabs lingered on the map indefinitely.)
    prisma.presence.updateMany({
      where: { id },
      data: { lastSeen: new Date(now) },
    }),

    // 2) Online peers, excluding self. Stale rows are filtered here, so they
    // vanish from the map even before the reaper physically deletes them.
    prisma.presence.findMany({
      where: {
        id: { not: id },
        lastSeen: { gte: staleCutoff },
      },
      select: { id: true, lat: true, lng: true, busy: true },
    }),

    // 3) Drain this user's mailbox atomically: DELETE … RETURNING removes
    // exactly the rows it hands back, so a concurrently-inserted signal is
    // never lost and there's no read-then-delete round trip.
    prisma.$queryRaw<SignalRow[]>`
      DELETE FROM "Signal"
      WHERE "toId" = ${id}
      RETURNING "id", "fromId", "toId", "type", "payload", "createdAt"`,
  ]);

  if (now - lastReapAt > REAP_INTERVAL_MS) {
    lastReapAt = now;
    after(() => reap(now));
  }

  inbox.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const response: PollResponse = {
    // The caller's own row is gone (reaped while their tab was throttled in
    // the background, or after a bfcache restore). Tell the client to re-join
    // instead of silently polling as an invisible ghost.
    present: heartbeat.count > 0,
    peers: peers.map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      busy: p.busy,
    })),
    signals: inbox.map((s) => ({
      id: s.id,
      fromId: s.fromId,
      toId: s.toId,
      type: s.type as PollResponse["signals"][number]["type"],
      payload: s.payload,
      createdAt: s.createdAt.toISOString(),
    })),
  };

  return Response.json(response);
}

// Garbage-collect stale presence rows and orphaned signals. Independent
// deletes — no atomicity needed, and avoids transactions over a PgBouncer
// pooler. Correctness doesn't depend on this running (reads filter by time),
// so it's throttled per server instance and runs off the response path.
async function reap(now: number) {
  try {
    await Promise.all([
      prisma.presence.deleteMany({
        where: { lastSeen: { lt: new Date(now - STALE_MS) } },
      }),
      prisma.signal.deleteMany({
        where: { createdAt: { lt: new Date(now - SIGNAL_TTL_MS) } },
      }),
    ]);
  } catch (err) {
    console.error("[pulse] reap failed", err);
  }
}
