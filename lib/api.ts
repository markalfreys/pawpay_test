// Client-side helpers for talking to the coordination API.
//
// `key` is this tab's secret session key. It goes in the Authorization header
// (never the URL) and is never shown to anyone: others only ever see the
// public id the server derives from it (see lib/session.ts).
import type { GlobeResponse, PollResponse, SignalType } from "@/lib/types";

function auth(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}` };
}

// Resolves to the user's *public* position — the offset dot others see.
export async function join(
  key: string,
  lat: number,
  lng: number,
): Promise<{ lat: number; lng: number }> {
  const res = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(key) },
    body: JSON.stringify({ lat, lng }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  const data = await res.json();
  return { lat: data.lat, lng: data.lng };
}

export async function globe(): Promise<GlobeResponse> {
  const res = await fetch("/api/globe");
  if (!res.ok) throw new Error(`globe failed: ${res.status}`);
  return res.json();
}

export async function poll(key: string): Promise<PollResponse> {
  const res = await fetch("/api/poll", {
    cache: "no-store",
    headers: auth(key),
  });
  if (!res.ok) throw new Error(`poll failed: ${res.status}`);
  return res.json();
}

export async function sendSignal(
  key: string,
  toId: string,
  type: SignalType,
  payload?: string,
): Promise<void> {
  await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(key) },
    body: JSON.stringify({ toId, type, payload }),
  });
}

// Fire-and-forget leave that survives the tab closing. sendBeacon can't set
// headers, so the key goes in the body.
export function leave(key: string): void {
  const body = JSON.stringify({ key });
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon("/api/leave", body);
  } else {
    void fetch("/api/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  }
}
