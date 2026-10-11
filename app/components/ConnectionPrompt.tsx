"use client";

import { useEffect, useId, useRef } from "react";
import { Video } from "lucide-react";
import { Orb } from "./ui";

// Reusable prompt for "someone wants to connect" and "someone wants to start
// video". The orb matches the requester's dot, and the drain bar shows how
// long until the request lapses on its own.
export default function ConnectionPrompt({
  title,
  subtitle,
  acceptLabel,
  declineLabel,
  onAccept,
  onDecline,
  color,
  kind = "connect",
  expiresInMs,
}: {
  title: string;
  subtitle?: string;
  acceptLabel: string;
  declineLabel: string;
  onAccept: () => void;
  onDecline: () => void;
  color: string;
  kind?: "connect" | "video";
  expiresInMs?: number;
}) {
  const titleId = useId();
  const acceptRef = useRef<HTMLButtonElement>(null);

  // Focus the primary action; Esc declines, Enter accepts.
  const onDeclineRef = useRef(onDecline);
  useEffect(() => {
    onDeclineRef.current = onDecline;
  });
  useEffect(() => {
    acceptRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDeclineRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="animate-fade absolute inset-0 z-40 flex items-end justify-center bg-black/45 p-4 pb-[calc(1rem+var(--safe-bottom))] backdrop-blur-[3px] sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass animate-pop relative w-full max-w-sm overflow-hidden rounded-[28px] p-6 text-center"
      >
        <div className="mx-auto mb-5 grid place-items-center">
          <span className="relative">
            <Orb color={color} size={64} pulsing />
            {kind === "video" && (
              <span className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border border-line bg-[var(--panel-solid)]">
                <Video className="h-3.5 w-3.5 text-ink" />
              </span>
            )}
          </span>
        </div>
        <h2 id={titleId} className="font-display text-[1.7rem] leading-tight">
          {title}
        </h2>
        {subtitle && <p className="mt-2 text-sm leading-relaxed text-muted">{subtitle}</p>}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onDecline}
            className="btn btn-ghost h-12 flex-1 px-4 text-sm"
          >
            {declineLabel}
          </button>
          <button
            ref={acceptRef}
            type="button"
            onClick={onAccept}
            className="btn btn-primary h-12 flex-1 px-4 text-sm"
          >
            {acceptLabel}
          </button>
        </div>
        {expiresInMs !== undefined && (
          <span
            aria-hidden
            className="animate-drain absolute inset-x-0 bottom-0 h-[3px] bg-linear-to-r from-accent to-accent-2 opacity-70"
            style={{ ["--drain-duration" as string]: `${expiresInMs}ms` }}
          />
        )}
      </div>
    </div>
  );
}
