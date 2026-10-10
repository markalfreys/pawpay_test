"use client";

import { useEffect, useRef } from "react";

export default function VideoPanel({
  localStream,
  remoteStream,
  onEnd,
}: {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
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
    // On wide screens the chat panel (max-w-md = 28rem) stays docked on the
    // right during a call: you can keep texting, and the video stage ends up
    // close to the camera's aspect ratio, so filling it barely crops.
    <div className="absolute inset-0 z-30 flex flex-col bg-black xl:right-[28rem]">
      {/* min-h-0: without it this flex item grows to the camera's intrinsic
          height and pushes the "End video" bar below the viewport. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
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
        {/* Stage: fills the screen (cover, like a phone call), but never
            wider than 16:9 so very wide windows can't crop away the face. */}
        <div
          className="relative mx-auto h-full w-full"
          style={{ maxWidth: "calc((100dvh - 5rem) * 16 / 9)" }}
        >
          <video
            ref={remoteRef}
            autoPlay
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
          {!remoteStream && (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-500">
              Waiting for stranger&rsquo;s video…
            </div>
          )}
        </div>
        {/* Local (picture-in-picture), mirrored like a selfie camera. Portrait
            on phones, landscape on wider screens to match the camera. */}
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-4 right-4 aspect-[3/4] w-28 -scale-x-100 rounded-lg border border-zinc-700 bg-zinc-800 object-cover shadow-lg sm:aspect-video sm:w-56"
        />
      </div>
      <div className="flex shrink-0 justify-center bg-zinc-950 p-4">
        <button
          onClick={onEnd}
          className="rounded-full bg-red-500 px-8 py-3 font-semibold text-white hover:bg-red-400"
        >
          End video
        </button>
      </div>
    </div>
  );
}
