"use client";

import { useEffect, useRef } from "react";
import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import { Orb, Spinner } from "./ui";

export default function VideoPanel({
  localStream,
  remoteStream,
  remoteCameraOff,
  micOn,
  camOn,
  color,
  onToggleMic,
  onToggleCam,
  onEnd,
}: {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  remoteCameraOff: boolean;
  micOn: boolean;
  camOn: boolean;
  color: string;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onEnd: () => void;
}) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const backdropRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== localStream) {
      localRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    for (const el of [remoteRef.current, backdropRef.current]) {
      if (el && el.srcObject !== remoteStream) el.srcObject = remoteStream;
    }
  }, [remoteStream]);

  return (
    // Full screen on phones/tablets. On wide screens it's a floating card and
    // the chat stays docked on the right (28rem incl. gaps): you can keep
    // texting, and the stage ends up close to the camera's aspect ratio, so
    // filling it barely crops.
    <section
      aria-label="Video call"
      className="animate-fade absolute inset-0 z-30 overflow-hidden bg-black xl:inset-y-4 xl:left-4 xl:right-[26rem] xl:rounded-[28px] xl:border xl:border-line"
    >
      {/* The stage measures itself (container queries) so it can cap at 16:9. */}
      <div className="absolute inset-0 [container-type:size]">
        {/* Blurred copy of the feed — only visible beside the stage on
            ultra-wide windows, where the stage is capped at 16:9. */}
        <video
          ref={backdropRef}
          autoPlay
          playsInline
          muted
          aria-hidden
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl"
        />
        {/* Fills the screen (cover, like a phone call), but never wider than
            16:9 so a very wide window can't crop the face away. */}
        <div className="relative mx-auto h-full w-full max-w-[calc(100cqh*16/9)]">
          <video
            ref={remoteRef}
            autoPlay
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
          {!remoteStream && (
            <div className="absolute inset-0 grid place-items-center bg-[var(--panel-solid)]">
              <div className="flex flex-col items-center gap-4 text-sm text-muted">
                <Orb color={color} size={72} pulsing />
                <span className="inline-flex items-center gap-2">
                  <Spinner className="h-3.5 w-3.5" /> Connecting video…
                </span>
              </div>
            </div>
          )}
          {remoteStream && remoteCameraOff && (
            <div className="animate-fade absolute inset-0 grid place-items-center bg-[var(--panel-solid)]">
              <div className="flex flex-col items-center gap-4 text-sm text-muted">
                <Orb color={color} size={72} />
                <span className="inline-flex items-center gap-2">
                  <VideoOff className="h-4 w-4" /> Their camera is off
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Scrim so the controls read over any video. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-linear-to-t from-black/70 to-transparent" />

      {/* Self view (mirrored, like a selfie camera). Portrait on phones,
          landscape on wider screens to match the camera. */}
      <div className="absolute right-3 top-[calc(0.75rem+var(--safe-top))] aspect-[3/4] w-24 overflow-hidden rounded-2xl border border-white/15 bg-[var(--panel-solid)] shadow-2xl sm:right-4 sm:top-4 sm:aspect-video sm:w-52">
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full -scale-x-100 object-cover"
        />
        {!camOn && (
          <div className="absolute inset-0 grid place-items-center bg-[var(--panel-solid)] text-muted">
            <VideoOff className="h-5 w-5" />
          </div>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-[calc(1.25rem+var(--safe-bottom))] flex justify-center px-4">
        <div className="glass animate-rise flex items-center gap-2 rounded-full p-2">
          <button
            type="button"
            onClick={onToggleMic}
            aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
            aria-pressed={!micOn}
            title={micOn ? "Mute" : "Unmute"}
            className={`icon-btn h-12 w-12 ${micOn ? "bg-white/[0.08] hover:bg-white/[0.15]" : "bg-white text-black"}`}
          >
            {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={onToggleCam}
            aria-label={camOn ? "Turn camera off" : "Turn camera on"}
            aria-pressed={!camOn}
            title={camOn ? "Camera off" : "Camera on"}
            className={`icon-btn h-12 w-12 ${camOn ? "bg-white/[0.08] hover:bg-white/[0.15]" : "bg-white text-black"}`}
          >
            {camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={onEnd}
            aria-label="End video"
            className="btn btn-danger h-12 px-5 text-sm"
          >
            <PhoneOff className="h-[18px] w-[18px]" />
            <span className="max-sm:hidden">End video</span>
          </button>
        </div>
      </div>
    </section>
  );
}
