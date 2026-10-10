"use client";

import { useId } from "react";

// A stranger's "face": a glowing orb in the same colour as their map dot.
export function Orb({
  color,
  size = 40,
  pulsing = false,
}: {
  color: string;
  size?: number;
  pulsing?: boolean;
}) {
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {pulsing && (
        <>
          <span
            className="animate-orb-ping absolute inset-0 rounded-full border-2"
            style={{ borderColor: color }}
          />
          <span
            className="animate-orb-ping absolute inset-0 rounded-full border-2"
            style={{ borderColor: color, animationDelay: "0.7s" }}
          />
        </>
      )}
      <span
        className="relative h-full w-full rounded-full"
        style={{
          background: `radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.75), ${color} 42%, color-mix(in srgb, ${color} 55%, #05060b) 100%)`,
          boxShadow: `0 0 ${Math.round(size * 0.6)}px -${Math.round(size * 0.1)}px ${color}`,
        }}
      />
    </span>
  );
}

// "Pulse" set in the display serif, with an ECG trace that sweeps like a
// monitor — the brand in one glance.
export function Wordmark({ size = "sm" }: { size?: "sm" | "lg" }) {
  const id = useId();
  const lg = size === "lg";
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg
        viewBox="0 0 44 20"
        className={
          lg ? "h-8 w-[4.4rem] md:h-10 md:w-[5.5rem] 2xl:h-12 2xl:w-[6.6rem]" : "h-4 w-[2.2rem]"
        }
        aria-hidden
      >
        <defs>
          <linearGradient id={id} x1="0" x2="1">
            <stop offset="0" stopColor="#ff6b81" />
            <stop offset="1" stopColor="#ffb36b" />
          </linearGradient>
        </defs>
        <path
          d="M1 11h10l3-8 5 15 4-11 2.5 4H43"
          fill="none"
          stroke={`url(#${id})`}
          strokeOpacity="0.25"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M1 11h10l3-8 5 15 4-11 2.5 4H43"
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={100}
          strokeDasharray="100 100"
          style={{ animation: "ecg 2.6s cubic-bezier(.45,0,.55,1) infinite" }}
        />
      </svg>
      <span
        className={`font-display leading-none tracking-tight ${
          lg ? "text-7xl md:text-8xl 2xl:text-[8.5rem]" : "text-[1.6rem]"
        }`}
      >
        Pulse
      </span>
    </span>
  );
}

// "● 12 online" with a live ping.
export function LivePill({
  online,
  label,
  className = "",
}: {
  online: number;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium text-ink/90 ${className}`}
    >
      <span className="relative inline-flex h-2 w-2">
        <span className="animate-live-ping absolute inset-0 rounded-full bg-live" />
        <span className="relative h-2 w-2 rounded-full bg-live" />
      </span>
      <span className="tabular-nums">
        {label ?? `${online} online`}
      </span>
    </span>
  );
}

export function Toast({ text }: { text: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="glass animate-pop pointer-events-none absolute left-1/2 top-[calc(1rem+var(--safe-top))] z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full px-4 py-2.5 text-center text-sm text-ink md:top-6"
    >
      {text}
    </div>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
