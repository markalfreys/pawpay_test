import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { STALE_MS } from "@/lib/presence";
import { clientIp, LIMITS, rateLimit } from "@/lib/ratelimit";
import { getSession, isPublicId, unauthorized } from "@/lib/session";
import type { SignalType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES: SignalType[] = [
  "request",
  "accept",
  "decline",
  "offer",
  "answer",
  "ice",
  "end",
  "wave",
  "unwave",
];

// Only the first handshake goes through the server (a data-channel-only SDP
// plus ICE candidates); media is renegotiated peer-to-peer. A few KB at most.
const MAX_PAYLOAD = 16 * 1024;

// POST /api/signal — Authorization: Bearer <key>; body { toId, type, payload? }
// Drops one message into the recipient's mailbox. The sender is whoever owns
// the key: `fromId` is no longer read from the body, so nobody can send as
// someone else.
//
// The server also tracks who is linked to whom (Presence.peerId) and only
// relays a signal that fits that link:
//   request           to anyone online and free; links the sender to them
//   accept            only to someone whose request to you is pending;
//                     links both ways and marks both busy
//   decline           only to someone whose request to you is pending
//   offer/answer/ice  only between two people who are connected
//   end               only to the person you're linked to; frees both sides
//   wave              to anyone online and free; no link, no payload. Waving
//                     back is a normal request that the waver's client accepts
//                     on its own (it already said hi), so consent still comes
//                     from both sides and nothing here can be forged.
//   unwave            to anyone; no link, no payload. Clears the wave between
//                     sender and recipient (taken back, or "No thanks"). It
//                     can only ever clear a wave involving its real sender.
// Before this, any client could mark any two users busy with a forged
// "accept", free someone mid-chat with "end", or push SDP and ICE at a
// stranger who never accepted. Signals that don't fit get a 409 and are never
// stored.
export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limited = rateLimit(`signal:${ip}`, ...LIMITS.signal);
  if (limited) return limited;

  const session = getSession(request);
  if (!session) return unauthorized();
  const me = session.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { toId, type, payload } = (body ?? {}) as Record<string, unknown>;

  if (!isPublicId(toId) || toId === me) {
    return Response.json({ error: "invalid toId" }, { status: 400 });
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type as SignalType)) {
    return Response.json({ error: "invalid type" }, { status: 400 });
  }
  const signalType = type as SignalType;
  const payloadStr = cleanPayload(signalType, payload);
  if (payloadStr === undefined) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  switch (signalType) {
    case "request": {
      const spam =
        rateLimit(`request:${ip}`, ...LIMITS.request) ??
        rateLimit(`request:${ip}:${toId}`, ...LIMITS.requestTarget);
      if (spam) return spam;

      const [sender, target] = await Promise.all([
        prisma.presence.findUnique({ where: { id: me }, select: { id: true } }),
        prisma.presence.findUnique({
          where: { id: toId },
          select: { busy: true, lastSeen: true },
        }),
      ]);
      if (!sender) return rejected("join first");

      // Enforce "one active connection at a time": if the target is offline
      // or busy, auto-decline the request instead of delivering it.
      if (!target || target.busy || target.lastSeen.getTime() < Date.now() - STALE_MS) {
        await sendDecline(toId, me);
        return Response.json({ ok: true, autoDeclined: true });
      }

      // The client only sends a request while idle, so any link the server
      // still holds for the sender is stale: replace it.
      await prisma.presence.updateMany({
        where: { id: me },
        data: { peerId: toId, busy: false },
      });
      break;
    }

    case "accept": {
      // `toId` asked us (their peerId points at us) and neither side is busy:
      // link both ways and mark both busy. One statement, so the pair can
      // never end up half-linked.
      const linked = await prisma.$executeRaw`
        UPDATE "Presence"
        SET "busy" = true,
            "peerId" = CASE WHEN "id" = ${me} THEN ${toId} ELSE ${me} END
        WHERE "id" IN (${me}, ${toId})
          AND EXISTS (SELECT 1 FROM "Presence" WHERE "id" = ${toId} AND "peerId" = ${me} AND NOT "busy")
          AND EXISTS (SELECT 1 FROM "Presence" WHERE "id" = ${me} AND NOT "busy")`;
      if (linked !== 2) return rejected("no pending request from this user");
      break;
    }

    case "decline": {
      const { count } = await prisma.presence.updateMany({
        where: { id: toId, peerId: me, busy: false },
        data: { peerId: null },
      });
      if (count === 0) return rejected("no pending request from this user");
      break;
    }

    case "end": {
      // Free each side only if it still points at the other. A requester who
      // gives up on someone already in another chat must not free them (this
      // used to clear `busy` on both ids unconditionally).
      const [mine, theirs] = await Promise.all([
        prisma.presence.updateMany({
          where: { id: me, peerId: toId },
          data: { busy: false, peerId: null },
        }),
        prisma.presence.updateMany({
          where: { id: toId, peerId: me },
          data: { busy: false, peerId: null },
        }),
      ]);
      if (mine.count + theirs.count === 0) return rejected("not linked to this user");
      break;
    }

    case "wave": {
      const spam =
        rateLimit(`wave:${ip}`, ...LIMITS.wave) ??
        rateLimit(`wave:${ip}:${toId}`, ...LIMITS.waveTarget);
      if (spam) return spam;

      // You're on the map and free (a wave from someone mid-chat could never
      // be answered), and they're online and free.
      const [sender, target] = await Promise.all([
        prisma.presence.findUnique({ where: { id: me }, select: { busy: true } }),
        prisma.presence.findUnique({
          where: { id: toId },
          select: { busy: true, lastSeen: true },
        }),
      ]);
      if (!sender) return rejected("join first");
      if (sender.busy) return rejected("you're in a conversation");
      if (!target || target.busy || target.lastSeen.getTime() < Date.now() - STALE_MS) {
        return rejected("not available");
      }
      break;
    }

    case "unwave": {
      const sender = await prisma.presence.findUnique({ where: { id: me }, select: { id: true } });
      if (!sender) return rejected("join first");
      break;
    }

    default: {
      // offer / answer / ice: only inside an accepted connection, so there's
      // no way to reach someone before they say yes.
      const linked = await prisma.presence.count({
        where: {
          OR: [
            { id: me, peerId: toId, busy: true },
            { id: toId, peerId: me, busy: true },
          ],
        },
      });
      if (linked !== 2) return rejected("not connected to this user");
    }
  }

  await prisma.signal.create({
    data: { fromId: me, toId, type: signalType, payload: payloadStr },
  });

  return Response.json({ ok: true });
}

function rejected(reason: string): Response {
  return Response.json({ error: reason }, { status: 409 });
}

// Helper: deliver an auto-decline from `target` back to `initiator`.
async function sendDecline(targetId: string, initiatorId: string) {
  await prisma.signal.create({
    data: { fromId: targetId, toId: initiatorId, type: "decline", payload: null },
  });
}

// Checks a payload against what each signal type carries and re-serialises
// only the fields the client uses, so the server never relays arbitrary data
// to a stranger. Returns the cleaned payload, null for "no payload", or
// undefined if it's invalid.
function cleanPayload(type: SignalType, payload: unknown): string | null | undefined {
  if (type !== "offer" && type !== "answer" && type !== "ice") {
    return payload === undefined || payload === null ? null : undefined;
  }
  if (typeof payload !== "string" || payload.length > MAX_PAYLOAD) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;

  if (type === "ice") {
    if (typeof d.candidate !== "string") return undefined;
    if (d.sdpMid != null && typeof d.sdpMid !== "string") return undefined;
    if (d.sdpMLineIndex != null && !Number.isInteger(d.sdpMLineIndex)) return undefined;
    if (d.usernameFragment != null && typeof d.usernameFragment !== "string") return undefined;
    return JSON.stringify({
      candidate: d.candidate,
      sdpMid: d.sdpMid ?? null,
      sdpMLineIndex: d.sdpMLineIndex ?? null,
      usernameFragment: d.usernameFragment ?? null,
    });
  }

  // offer / answer: the description's own type must match the signal's.
  if (d.type !== type || typeof d.sdp !== "string") return undefined;
  return JSON.stringify({ type: d.type, sdp: d.sdp });
}
