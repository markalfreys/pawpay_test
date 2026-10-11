"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, PhoneOff, SendHorizontal, Video, X } from "lucide-react";
import { Orb, Spinner } from "./ui";

export interface ChatMessage {
  id: number;
  mine: boolean;
  text: string;
  at: number;
  // Small centred status line ("Video call started"), not a bubble.
  system?: boolean;
}

export const MAX_MESSAGE_LENGTH = 1000;

export type ChatStatus = "connecting" | "connected" | "ended";

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function ChatPanel({
  messages,
  status,
  endedReason,
  color,
  typing,
  videoBusy,
  videoRequesting,
  onSend,
  onTyping,
  onStartVideo,
  onCancelVideo,
  onEnd,
  onClose,
}: {
  messages: ChatMessage[];
  status: ChatStatus;
  endedReason?: string;
  color: string;
  typing: boolean;
  videoBusy: boolean;
  videoRequesting: boolean;
  onSend: (text: string) => void;
  onTyping: () => void;
  onStartVideo: () => void;
  onCancelVideo: () => void;
  onEnd: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const connected = status === "connected";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, typing, status]);

  // Desktop: jump straight into typing once connected. (Not on phones —
  // popping the keyboard unasked hides half the screen.)
  useEffect(() => {
    if (connected && window.matchMedia("(min-width: 768px)").matches) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [connected]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !connected) return;
    onSend(text);
    setDraft("");
  }

  return (
    <aside
      aria-label="Chat with a stranger"
      className="animate-sheet-up md:animate-slide-in md:glass absolute inset-0 z-20 flex flex-col overflow-hidden bg-[var(--panel-solid)] md:inset-y-4 md:left-auto md:right-4 md:w-[24rem] md:rounded-[28px]"
    >
      <header className="flex items-center gap-3 border-b border-line px-4 pb-3 pt-[calc(0.75rem+var(--safe-top))] md:pt-4">
        <Orb color={color} size={38} pulsing={status === "connecting"} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-tight">Stranger</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            {status === "connecting" && (
              <>
                <Spinner className="h-3 w-3" /> Connecting…
              </>
            )}
            {status === "connected" && (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-live" />
                Connected
                <span className="text-faint">·</span>
                <Lock className="h-3 w-3" /> peer-to-peer
              </>
            )}
            {status === "ended" && <>Chat ended</>}
          </p>
        </div>
        {status === "ended" ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            title="Close"
            className="icon-btn h-10 w-10 bg-white/[0.06] hover:bg-white/[0.12]"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onStartVideo}
              disabled={!connected || videoBusy}
              aria-label="Start video"
              title="Start video"
              className="icon-btn h-10 w-10 bg-white/[0.06] hover:bg-white/[0.12]"
            >
              <Video className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              onClick={onEnd}
              aria-label="End chat"
              title="End chat"
              className="icon-btn h-10 w-10 bg-danger text-white hover:bg-[#f04a60]"
            >
              <PhoneOff className="h-[17px] w-[17px]" />
            </button>
          </>
        )}
      </header>

      {videoRequesting && (
        <div className="animate-fade flex items-center gap-3 border-b border-line bg-white/[0.03] px-4 py-2.5 text-sm">
          <Spinner className="h-3.5 w-3.5 text-accent-2" />
          <span className="flex-1 text-muted">Waiting for them to turn on video…</span>
          <button
            type="button"
            onClick={onCancelVideo}
            className="rounded-full px-2 py-1 text-xs font-semibold text-ink hover:bg-white/10"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {messages.length === 0 && status !== "ended" && (
          <div className="animate-fade mx-auto mt-10 max-w-[17rem] text-center">
            <p className="font-display text-[1.9rem] leading-tight">Say hello</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Messages travel straight between you two. The server never sees
              them, and they vanish when the chat ends.
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.system) {
            return (
              <p key={m.id} className="animate-fade my-3 text-center text-[11px] font-medium uppercase tracking-wider text-faint">
                {m.text}
              </p>
            );
          }
          const prev = messages[i - 1];
          const grouped = prev && !prev.system && prev.mine === m.mine;
          return (
            <div
              key={m.id}
              className={`animate-rise flex ${m.mine ? "justify-end" : "justify-start"} ${grouped ? "mt-1" : "mt-3"}`}
              style={{ animationDuration: "0.3s" }}
            >
              <p
                title={time(m.at)}
                className={`max-w-[82%] whitespace-pre-wrap px-4 py-2.5 text-[15px] leading-snug [overflow-wrap:anywhere] ${
                  m.mine
                    ? "rounded-[20px] rounded-br-md bg-linear-to-br from-accent to-accent-2 text-[#1b0b10]"
                    : "rounded-[20px] rounded-bl-md border border-line bg-white/[0.07] text-ink"
                }`}
              >
                {m.text}
              </p>
            </div>
          );
        })}

        {typing && status === "connected" && (
          <div className="animate-fade mt-3 flex" aria-label="Stranger is typing">
            <span className="flex items-center gap-1 rounded-[20px] rounded-bl-md border border-line bg-white/[0.07] px-4 py-3.5">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
            </span>
          </div>
        )}

        {status === "ended" && (
          <div className="animate-pop mx-auto mt-6 max-w-[16rem] text-center">
            <p className="text-sm font-semibold">{endedReason ?? "Chat ended"}</p>
            <p className="mt-1 text-xs text-muted">This conversation disappears when you close it.</p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {status === "ended" ? (
        <div className="border-t border-line p-3 pb-[calc(0.75rem+var(--safe-bottom))] md:pb-3">
          <button type="button" onClick={onClose} className="btn btn-ghost h-12 w-full text-sm">
            Back to the globe
          </button>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="flex items-center gap-2 border-t border-line p-3 pb-[calc(0.75rem+var(--safe-bottom))] md:pb-3"
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (e.target.value) onTyping();
            }}
            placeholder={connected ? "Write a message…" : "Connecting…"}
            aria-label="Message"
            disabled={!connected}
            maxLength={MAX_MESSAGE_LENGTH}
            autoComplete="off"
            enterKeyHint="send"
            className="h-12 min-w-0 flex-1 rounded-full border border-line bg-white/[0.05] px-5 text-[15px] text-ink outline-none transition placeholder:text-faint focus:border-accent/50 focus:bg-white/[0.08] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!connected || !draft.trim()}
            aria-label="Send"
            className="btn btn-primary h-12 w-12 shrink-0 p-0"
          >
            <SendHorizontal className="h-[18px] w-[18px]" />
          </button>
        </form>
      )}
    </aside>
  );
}
