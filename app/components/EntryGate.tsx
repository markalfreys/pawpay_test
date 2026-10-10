"use client";

import { useState } from "react";

export default function EntryGate({
  onReady,
}: {
  onReady: (lat: number, lng: number) => Promise<void>;
}) {
  const [status, setStatus] = useState<"idle" | "locating" | "error">("idle");
  const [error, setError] = useState<string>("");

  function fail(message: string) {
    setStatus("error");
    setError(message);
  }

  async function located(pos: GeolocationPosition) {
    try {
      await onReady(pos.coords.latitude, pos.coords.longitude);
    } catch {
      fail("Couldn't reach Pulse. Check your connection and try again.");
    }
  }

  function locationError(err: GeolocationPositionError) {
    fail(
      err.code === err.PERMISSION_DENIED
        ? "Location permission is required to place you on the map."
        : "Couldn't get your location. Please try again.",
    );
  }

  function enter() {
    if (!("geolocation" in navigator)) {
      fail("Your browser doesn't support location access.");
      return;
    }
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      located,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) return locationError(err);
        // Desktops without GPS often time out on a high-accuracy fix. The dot
        // is offset 1–3 km anyway, so a coarse network fix is plenty.
        navigator.geolocation.getCurrentPosition(located, locationError, {
          enableHighAccuracy: false,
          timeout: 10_000,
          maximumAge: 60_000,
        });
      },
      // High accuracy + maximumAge:0 forces a fresh fix (Wi-Fi/GPS scan)
      // instead of reusing the browser's cached IP-based location.
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-8 bg-zinc-950 p-6 text-zinc-100">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Pulse</h1>
        <p className="mt-2 max-w-sm text-zinc-400">
          A living globe of anonymous strangers. Drop onto the map and connect.
        </p>
      </div>

      <button
        onClick={enter}
        disabled={status === "locating"}
        className="rounded-full bg-emerald-400 px-8 py-3 font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:opacity-60"
      >
        {status === "locating" ? "Locating…" : "Enter Pulse"}
      </button>

      {status === "error" && (
        <p className="max-w-sm text-center text-sm text-red-400">{error}</p>
      )}

      <p className="max-w-sm text-center text-xs text-zinc-500">
        No sign-up. Your dot is placed 1–3&nbsp;km from your real location.
        Nothing is stored — closing the tab ends everything.
      </p>
    </div>
  );
}
