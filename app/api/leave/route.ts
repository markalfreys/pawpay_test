import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { isSessionKey, publicIdFor, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/leave — body { key }. Removes the presence row and any pending
// signals to/from this user. Called via navigator.sendBeacon on tab close,
// which can't set headers, so the secret key comes in the body (and the body
// may arrive as text — parse defensively). It used to take the public id,
// which let anyone remove anyone from the map.
export async function POST(request: NextRequest) {
  let key: unknown;
  try {
    const text = await request.text();
    key = text ? JSON.parse(text)?.key : undefined;
  } catch {
    key = undefined;
  }

  if (!isSessionKey(key)) return unauthorized();
  const id = publicIdFor(key);

  // Independent cleanup writes — no atomicity needed (and interactive
  // transactions are unreliable over a PgBouncer pooler).
  await prisma.signal.deleteMany({
    where: { OR: [{ toId: id }, { fromId: id }] },
  });
  // Release whoever is still linked to us (our chat partner, or someone whose
  // request to us is pending) so they don't stay "busy" with a ghost.
  await prisma.presence.updateMany({
    where: { peerId: id },
    data: { busy: false, peerId: null },
  });
  await prisma.presence.deleteMany({ where: { id } });

  return Response.json({ ok: true });
}
