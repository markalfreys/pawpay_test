import { prisma } from "@/lib/prisma";
import { STALE_MS } from "@/lib/presence";
import type { GlobeResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The entry screen shows a spinning globe with everyone online before you
// join. Read-only and anonymous: no ids (nothing to target), coordinates
// rounded to ~100 m on top of the 1–3 km privacy offset, and capped.
const MAX_DOTS = 500;

// GET /api/globe — { online, peers: [{ lat, lng, busy }] }
export async function GET() {
  const rows = await prisma.presence.findMany({
    where: { lastSeen: { gte: new Date(Date.now() - STALE_MS) } },
    select: { lat: true, lng: true, busy: true },
    orderBy: { lastSeen: "desc" },
    take: MAX_DOTS,
  });

  const body: GlobeResponse = {
    online: rows.length,
    peers: rows.map((r) => ({
      lat: Math.round(r.lat * 1000) / 1000,
      lng: Math.round(r.lng * 1000) / 1000,
      busy: r.busy,
    })),
  };

  // Every visitor on the entry screen polls this, so let the CDN absorb it:
  // a few seconds of staleness is invisible on a spinning globe.
  return Response.json(body, {
    headers: { "Cache-Control": "public, s-maxage=4, stale-while-revalidate=10" },
  });
}
