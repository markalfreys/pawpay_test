"use client";

import { useState } from "react";
import { ArrowRight, Lock, MapPin, Sparkles } from "lucide-react";
import { Spinner, Wordmark } from "./ui";
import { primeChime } from "@/lib/chime";

type Status = "idle" | "locating" | "joining" | "error";

// The first screen, laid over the spinning live globe: you can see real
// people glowing on it before you decide to join.
export default function EntryGate({
  onReady,
  leaving,
}: {
  onReady: (lat: number, lng: number) => Promise<void>;
  // Fading out while the camera flies in.
  leaving: boolean;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");

  function fail(message: string) {
    setStatus("error");
    setError(message);
  }

  async function located(pos: GeolocationPosition) {
    setStatus("joining");
    try {
      await onReady(pos.coords.latitude, pos.coords.longitude);
    } catch {
      fail("Couldn't reach Pulse. Check your connection and try again.");
    }
  }

  function locationError(err: GeolocationPositionError) {
    fail(
      err.code === err.PERMISSION_DENIED
        ? "Pulse needs your location to place your dot. It's offset 1–3 km and never stored — allow it in your browser's site settings, then try again."
        : "Couldn't get your location. Please try again.",
    );
  }

  function enter() {
    if (status === "locating" || status === "joining") return;
    // Audio may only start from a user gesture — unlock the request chime now.
    primeChime();
    if (!("geolocation" in navigator)) {
      fail("Your browser doesn't support location access.");
      return;
    }
    setStatus("locating");
    setError("");
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

  const busy = status === "locating" || status === "joining";

  return (
    <div
      className="gate absolute inset-0 z-40 flex flex-col justify-end md:justify-center"
      data-leaving={leaving}
    >
      {/* Scrims so the copy reads over the globe without boxing it in. They
          stop short of the bottom edge so the Mapbox logo + attribution stay
          visible (that strip is open space, the same colour as the page). */}
      <div className="pointer-events-none absolute inset-x-0 bottom-12 h-[58%] bg-linear-to-t from-bg via-bg/85 to-transparent md:bottom-12 md:left-0 md:top-0 md:h-auto md:w-[52%] md:bg-linear-to-r" />

      {/* Widths mirror GATE_COPY_REM / GATE_COPY_2XL_REM in WorldMap.tsx. */}
      <div className="gate-copy relative w-full max-w-xl px-6 pb-[calc(3.5rem+var(--safe-bottom))] md:w-[30rem] md:max-w-none md:px-0 md:pb-0 2xl:w-[36rem]">
        <h1 className="animate-rise" style={{ animationDelay: "0.2s" }}>
          <Wordmark size="lg" />
        </h1>

        <p
          className="animate-rise mt-4 font-display text-[1.75rem] italic leading-tight text-ink/95 md:text-4xl 2xl:text-5xl"
          style={{ animationDelay: "0.3s" }}
        >
          The world is alive. Say hello.
        </p>
        <p
          className="animate-rise mt-3 text-[15px] font-medium text-ink/85 2xl:text-lg"
          style={{ animationDelay: "0.35s" }}
        >
          8 billion people. One glowing globe. Endless connections.
        </p>
        <p
          className="animate-rise mt-2 max-w-md text-[15px] leading-relaxed text-muted 2xl:max-w-lg 2xl:text-[17px]"
          style={{ animationDelay: "0.4s" }}
        >
          Somewhere in the world, someone is waiting to meet you. Explore the
          globe, tap a glowing dot, and turn a stranger into a connection.
        </p>

        <div className="animate-rise mt-8" style={{ animationDelay: "0.5s" }}>
          <button
            type="button"
            onClick={enter}
            disabled={busy}
            className="btn btn-primary h-14 w-full px-8 text-base sm:w-auto 2xl:h-16 2xl:px-10 2xl:text-lg"
          >
            {busy ? (
              <>
                <Spinner />
                {status === "locating" ? "Finding you…" : "Dropping you in…"}
              </>
            ) : (
              <>
                Enter Pulse
                <ArrowRight className="h-[18px] w-[18px]" />
              </>
            )}
          </button>
        </div>

        {status === "error" && (
          <p
            role="alert"
            className="animate-pop mt-4 max-w-md rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-[#ffb4bf]"
          >
            {error}
          </p>
        )}

        <ul
          className="animate-rise mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted"
          style={{ animationDelay: "0.6s" }}
        >
          <li className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-accent-2" /> No sign-up
          </li>
          <li className="inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-accent-2" /> Your dot lands 1–3 km from you
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-accent-2" /> Nothing is stored
          </li>
        </ul>
      </div>
    </div>
  );
}
