// Best-effort, in-memory, fixed-window rate limiting.
//
// Each server instance counts on its own, so on Vercel the real ceiling is
// roughly (limit × warm instances). That still stops one script from flooding
// the database or spamming someone with connection prompts, without adding a
// service (the requirements rule out anything beyond Vercel). Volumetric
// protection belongs at the edge: Vercel Firewall rate-limit rules.

// [max requests, window in ms]
export const LIMITS = {
  // Per IP. New sessions and re-joins.
  join: [30, 60_000],
  // Per IP. One client polls at most every 400 ms (25 per 10 s); this leaves
  // room for a busy NAT (campus, office) behind a single address.
  poll: [600, 10_000],
  // Per IP. A WebRTC handshake is a burst of ~20 signals per side.
  signal: [300, 10_000],
  // Per IP. Every request pops up a prompt with a chime on someone's screen.
  request: [30, 60_000],
  // Per IP and target, so one person can't be flooded with prompts.
  requestTarget: [3, 60_000],
} satisfies Record<string, [number, number]>;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();
const MAX_KEYS = 10_000;

// Returns a 429 response once `bucket` has been hit more than `limit` times in
// the current window, or null if the request may proceed.
export function rateLimit(bucket: string, limit: number, windowMs: number): Response | null {
  const now = Date.now();
  let w = windows.get(bucket);
  if (!w || w.resetAt <= now) {
    if (windows.size >= MAX_KEYS) prune(now);
    w = { count: 0, resetAt: now + windowMs };
    windows.set(bucket, w);
  }
  w.count++;
  if (w.count <= limit) return null;
  return Response.json(
    { error: "too many requests" },
    { status: 429, headers: { "Retry-After": String(Math.ceil((w.resetAt - now) / 1000)) } },
  );
}

function prune(now: number) {
  for (const [bucket, w] of windows) {
    if (w.resetAt <= now) windows.delete(bucket);
  }
  // Still full (a flood of distinct buckets): start over rather than grow
  // without bound.
  if (windows.size >= MAX_KEYS) windows.clear();
}

// Vercel sets x-forwarded-for itself and overwrites any value the client sent,
// so it can't be spoofed there. Behind another proxy, check that it does the
// same before trusting this.
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}
