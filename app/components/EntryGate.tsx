"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Lock, MapPin, Sparkles } from "lucide-react";
import { Spinner, Wordmark } from "./ui";
import { primeChime } from "@/lib/chime";

type Status = "idle" | "locating" | "joining" | "error";

// Why location failed, worded for what the user can actually do. After
// "Never allow", a script can't bring the browser's prompt back. Chrome's
// <geolocation> element (a button the browser draws itself) can, so where
// it exists we offer it; elsewhere we explain where to undo the block.
const LOCATION_DISMISSED =
  "Pulse needs your location to place your dot. It's offset 1–3 km and never stored. Press Enter Pulse and choose Allow.";
const LOCATION_BLOCKED_BUTTON =
  "Location is blocked for this site. Press the button below and choose Allow to let Pulse place your dot.";
const LOCATION_BLOCKED =
  "Location is blocked for this site, so your browser won't ask again. Click the icon at the left of the address bar and set Location to Allow (or Ask). Pulse will pick it up from there.";

const hasGeolocationElement = () => "HTMLGeolocationElement" in window;
const LOCATION_DENIED =
  "Pulse needs your location to place your dot. It's offset 1–3 km and never stored — allow it in your browser's site settings, then try again.";

async function geoPermission(): Promise<PermissionStatus | null> {
  try {
    return (await navigator.permissions?.query({ name: "geolocation" })) ?? null;
  } catch {
    return null; // no Permissions API (older Safari)
  }
}

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
  // Bumped on every failure so the message pops again even when the text is
  // the same (a click on a blocked site fails instantly).
  const [attempt, setAttempt] = useState(0);
  // Location is blocked and the browser has a <geolocation> button to undo it.
  const [recovery, setRecovery] = useState(false);
  // Location can arrive from more than one place (Enter Pulse, the
  // <geolocation> button, the permission watcher). Join once.
  const joining = useRef(false);

  function fail(message: string) {
    setStatus("error");
    setError(message);
    setAttempt((n) => n + 1);
  }

  // After a refusal, watch the permission: allowing it in site settings
  // carries on by itself, and resetting it to "Ask" means the next click
  // shows the browser's prompt again.
  const watched = useRef<PermissionStatus | null>(null);
  const enterRef = useRef(enter);
  useEffect(() => {
    enterRef.current = enter;
  });
  useEffect(
    () => () => {
      if (watched.current) watched.current.onchange = null;
    },
    [],
  );
  function watch(permission: PermissionStatus) {
    if (watched.current) return;
    watched.current = permission;
    permission.onchange = () => {
      if (permission.state === "granted") enterRef.current();
      else if (permission.state === "prompt") {
        setStatus("idle");
        setError("");
      }
    };
  }

  async function located(pos: GeolocationPosition) {
    if (joining.current) return;
    joining.current = true;
    setStatus("joining");
    try {
      await onReady(pos.coords.latitude, pos.coords.longitude);
    } catch {
      joining.current = false;
      fail("Couldn't reach Pulse. Check your connection and try again.");
    }
  }
  const locatedRef = useRef(located);
  useEffect(() => {
    locatedRef.current = located;
  });

  // The <geolocation> button reports through a "location" event: a position
  // once they allow, or an error if they refuse again.
  function geolocationRef(el: HTMLGeolocationElement | null) {
    if (!el) return;
    const onLocation = () => {
      if (el.position) void locatedRef.current(el.position);
      else setAttempt((n) => n + 1);
    };
    el.addEventListener("location", onLocation);
    return () => el.removeEventListener("location", onLocation);
  }

  async function locationError(err: GeolocationPositionError) {
    if (err.code !== err.PERMISSION_DENIED) {
      fail("Couldn't get your location. Please try again.");
      return;
    }
    // "denied": they chose Never allow / Block. "prompt": they only closed
    // the popup, so the next click asks again.
    const permission = await geoPermission();
    if (permission) watch(permission);
    const blocked = permission?.state === "denied";
    setRecovery(blocked && hasGeolocationElement());
    fail(
      blocked
        ? hasGeolocationElement()
          ? LOCATION_BLOCKED_BUTTON
          : LOCATION_BLOCKED
        : permission?.state === "prompt"
          ? LOCATION_DISMISSED
          : LOCATION_DENIED,
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
            key={attempt}
            role="alert"
            className="animate-pop mt-4 max-w-md rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-[#ffb4bf]"
          >
            {error}
          </p>
        )}
        {status === "error" && recovery && (
          // Drawn by the browser (icon and label included); pressing it brings
          // the location prompt back even after "Never allow". Chrome only
          // accepts solid, high-contrast, full-opacity styling on it.
          <geolocation
            ref={geolocationRef}
            className="mt-3 h-11 rounded-full bg-accent-2 px-5 text-sm font-semibold text-[#1b0b10]"
          />
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
