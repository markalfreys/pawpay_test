import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyPrivacyOffset, isValidLatLng } from "@/lib/geo";
import { clientIp, LIMITS, rateLimit } from "@/lib/ratelimit";
import { getSession, offsetSeed, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/join — Authorization: Bearer <key>; body { lat, lng } (raw coords).
// Applies a 1–3 km privacy offset and upserts the presence row. Raw
// coordinates are never stored. Returns the caller's public id and position.
export async function POST(request: NextRequest) {
  const limited = rateLimit(`join:${clientIp(request)}`, ...LIMITS.join);
  if (limited) return limited;

  const session = getSession(request);
  if (!session) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { lat, lng } = (body ?? {}) as Record<string, unknown>;

  if (!isValidLatLng(lat, lng)) {
    return Response.json({ error: "invalid coordinates" }, { status: 400 });
  }

  const offset = applyPrivacyOffset(lat as number, lng as number, offsetSeed(session.key));

  await prisma.presence.upsert({
    where: { id: session.id },
    create: {
      id: session.id,
      lat: offset.lat,
      lng: offset.lng,
      busy: false,
      lastSeen: new Date(),
    },
    update: {
      lat: offset.lat,
      lng: offset.lng,
      lastSeen: new Date(),
    },
  });

  // Hand back the public (offset) position so the client can show the user
  // exactly where everyone else sees them — not their real location.
  return Response.json({ ok: true, id: session.id, lat: offset.lat, lng: offset.lng });
}
