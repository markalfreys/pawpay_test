"use client";

import { Orb } from "./ui";

// Shown while we wait for a stranger to answer a request we sent (connection
// or video). Non-blocking: the globe stays visible and interactive behind it.
export default function CallingCard({
  color,
  title,
  subtitle,
  onCancel,
  timeoutMs,
}: {
  color: string;
  title: string;
  subtitle: string;
  onCancel: () => void;
  timeoutMs: number;
}) {
  return (
    // On phones the card sits above the Mapbox logo, which must stay visible.
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(2.75rem+var(--safe-bottom))] z-30 flex justify-center px-4 md:bottom-[calc(1.25rem+var(--safe-bottom))]">
      <div
        role="status"
        aria-live="polite"
        className="glass animate-rise pointer-events-auto relative flex w-full max-w-sm items-center gap-4 overflow-hidden rounded-3xl p-4 pr-3"
      >
        <Orb color={color} size={44} pulsing />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <p className="truncate text-sm text-muted">{subtitle}</p>
        </div>
        <button type="button" onClick={onCancel} className="btn btn-ghost h-10 px-4 text-sm">
          Cancel
        </button>
        <span
          aria-hidden
          className="animate-drain absolute inset-x-0 bottom-0 h-[3px] bg-linear-to-r from-accent to-accent-2 opacity-70"
          style={{ ["--drain-duration" as string]: `${timeoutMs}ms` }}
        />
      </div>
    </div>
  );
}
