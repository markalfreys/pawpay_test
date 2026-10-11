"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Orb } from "./ui";

// `quiet`: ghost styling, for a primary action that shouldn't shout.
type Action = { label: string; icon?: ReactNode; onClick: () => void; quiet?: boolean };

// A card that appears on its own (a wave arriving) ignores clicks this long,
// so a click aimed at whatever it replaced can't land on it instead.
const ARM_MS = 600;

// One stranger, and what you can do with them right now: wave or ask to chat
// (you tapped their dot), or wave back, say no thanks or block (they waved
// at you). Non-blocking like
// the calling card, so the globe stays usable behind it. With `expiresAt`, a
// bar drains until their wave (or yours) fades.
export default function PeerCard({
  color,
  title,
  subtitle,
  hint,
  primary,
  secondary,
  extra,
  expiresAt,
  ttlMs,
  autoFocus = false,
  onClose,
}: {
  color: string;
  title: string;
  subtitle: string;
  hint?: string;
  // Without a primary action, the secondary one stands alone (quietly).
  primary?: Action;
  secondary?: Action;
  // A small text link under the buttons (e.g. "Block this person").
  extra?: Action;
  expiresAt?: number;
  ttlMs?: number;
  // Only when the user opened it (tapping a dot); a wave arriving on its own
  // shouldn't steal focus.
  autoFocus?: boolean;
  onClose: () => void;
}) {
  // The main action, focused when the user opened the card.
  const mainRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (autoFocus) mainRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoFocus]);

  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = performance.now();
  }, []);
  const guarded = (fn: () => void) => () => {
    if (!autoFocus && performance.now() - shownAt.current < ARM_MS) return;
    fn();
  };

  // Start the drain part-way through when the wave is already a while old.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !expiresAt || !ttlMs) return;
    const left = Math.max(0, Math.min(ttlMs, expiresAt - Date.now()));
    bar.style.animationDuration = `${ttlMs}ms`;
    bar.style.animationDelay = `${left - ttlMs}ms`;
  }, [expiresAt, ttlMs]);

  return (
    // On phones the card sits above the Mapbox logo, which must stay visible.
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(2.75rem+var(--safe-bottom))] z-30 flex justify-center px-4 md:bottom-[calc(1.25rem+var(--safe-bottom))]">
      <div
        role="region"
        aria-label={title}
        aria-live="polite"
        className="glass animate-rise pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-3xl p-4"
      >
        <div className="flex items-center gap-4">
          <Orb color={color} size={44} pulsing />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{title}</p>
            <p className="truncate text-sm text-muted">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="icon-btn h-9 w-9 self-start text-muted hover:bg-white/[0.06] hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {hint && <p className="mt-3 text-xs leading-relaxed text-muted">{hint}</p>}
        <div className="mt-4 flex gap-3">
          {secondary && (
            <button
              ref={primary ? undefined : mainRef}
              type="button"
              onClick={guarded(secondary.onClick)}
              className="btn btn-ghost h-11 flex-1 px-4 text-sm"
            >
              {secondary.icon}
              {secondary.label}
            </button>
          )}
          {primary && (
            <button
              ref={mainRef}
              type="button"
              onClick={guarded(primary.onClick)}
              className={`btn ${primary.quiet ? "btn-ghost" : "btn-primary"} h-11 flex-1 px-4 text-sm`}
            >
              {primary.icon}
              {primary.label}
            </button>
          )}
        </div>
        {extra && (
          <button
            type="button"
            onClick={guarded(extra.onClick)}
            className="mt-2 w-full py-1 text-center text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
          >
            {extra.label}
          </button>
        )}
        {expiresAt !== undefined && ttlMs !== undefined && (
          <span
            ref={barRef}
            aria-hidden
            className="animate-drain absolute inset-x-0 bottom-0 h-[3px] bg-linear-to-r from-accent to-accent-2 opacity-70"
          />
        )}
      </div>
    </div>
  );
}

// Both dots sit 1–3 km from where people really are, so under ~10 km a number
// would be false precision.
export function distanceLabel(km: number): string {
  if (km < 10) return "Very close to you";
  const rounded = km < 100 ? Math.round(km) : Math.round(km / 10) * 10;
  return `About ${rounded.toLocaleString("en-US")} km away`;
}
