"use client";

import { useEffect, useRef, useState } from "react";
import EntryGate from "./components/EntryGate";
import WorldMap from "./components/WorldMap";
import ConnectionPrompt from "./components/ConnectionPrompt";
import ChatPanel, { type ChatMessage } from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import { join, leave, poll, sendSignal } from "@/lib/api";
import { PeerSession, type DescType, type PeerControl } from "@/lib/webrtc";
import { FAST_POLL_INTERVAL_MS, POLL_INTERVAL_MS } from "@/lib/presence";
import { type PeerDot, type PollResponse, type SignalMsg } from "@/lib/types";

type Conn =
  | { kind: "idle" }
  | { kind: "requesting"; peerId: string }
  | { kind: "incoming"; peerId: string }
  | { kind: "connecting"; peerId: string }
  | { kind: "connected"; peerId: string };

type VideoState = "none" | "requesting" | "incoming" | "active";

const REQUEST_TIMEOUT_MS = 30_000;
// Accepted but the WebRTC data channel never opened (peer vanished mid-handshake,
// or the network blocks P2P). Without this the chat sat on "Connecting…" forever.
const CONNECT_TIMEOUT_MS = 25_000;
const VIDEO_REQUEST_TIMEOUT_MS = 30_000;
// The partner's dot must be missing from this many consecutive polls before we
// treat them as gone (one miss can be a transient read).
const PEER_GONE_POLLS = 2;

export default function Home() {
  const [phase, setPhase] = useState<"gate" | "live">("gate");
  const [sessionId] = useState(() => crypto.randomUUID());
  const [peers, setPeers] = useState<PeerDot[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  const [conn, _setConn] = useState<Conn>({ kind: "idle" });
  const connRef = useRef<Conn>(conn);
  const setConn = (c: Conn) => {
    connRef.current = c;
    _setConn(c);
  };

  const [video, _setVideo] = useState<VideoState>("none");
  const videoRef = useRef<VideoState>(video);
  const setVideo = (v: VideoState) => {
    videoRef.current = v;
    _setVideo(v);
  };

  const peerRef = useRef<PeerSession | null>(null);
  const msgId = useRef(0);
  // One timer covers whichever pre-chat phase we're in (requesting → connecting).
  const connTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationRef = useRef<{ lat: number; lng: number } | null>(null);
  const missingPolls = useRef(0);
  const rejoining = useRef(false);

  function showNotice(text: string) {
    setNotice(text);
    // Reset the timer so a newer notice isn't cleared early by an older one.
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }

  function addMessage(mine: boolean, text: string) {
    setMessages((prev) => [...prev, { id: msgId.current++, mine, text }]);
  }

  function clearConnTimer() {
    if (connTimer.current) clearTimeout(connTimer.current);
    connTimer.current = null;
  }

  function clearVideoTimer() {
    if (videoTimer.current) clearTimeout(videoTimer.current);
    videoTimer.current = null;
  }

  // Ends the current connection locally. With `notifyPeer`, also sends "end"
  // so the server frees both busy flags and the stranger's UI closes too —
  // previously local failures (network, timeouts) never told the server, so
  // the user stayed "busy" on everyone's map.
  function teardown(message?: string, notifyPeer = false) {
    const c = connRef.current;
    if (notifyPeer && c.kind !== "idle") {
      void sendSignal(sessionId, c.peerId, "end");
    }
    clearConnTimer();
    clearVideoTimer();
    missingPolls.current = 0;
    peerRef.current?.close();
    peerRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
    setMessages([]);
    setConn({ kind: "idle" });
    if (message) showNotice(message);
  }

  function armConnectTimeout(peerId: string) {
    clearConnTimer();
    connTimer.current = setTimeout(() => {
      const c = connRef.current;
      if (c.kind === "connecting" && c.peerId === peerId) {
        teardown("Couldn't connect to the stranger.", true);
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function startPeer(peerId: string, initiator: boolean) {
    const ps = new PeerSession(initiator, {
      onSignal: (type: DescType, payload: string) => {
        void sendSignal(sessionId, peerId, type, payload);
      },
      onChat: (text) => addMessage(false, text),
      onControl: (ctrl) => handleControl(ctrl),
      onRemoteStream: (stream) => setRemoteStream(stream),
      onConnectionState: (state) => {
        if (state === "failed" && peerRef.current === ps) {
          teardown("Connection failed (network).", true);
        }
      },
      onChannelOpen: () => {
        clearConnTimer();
        setConn({ kind: "connected", peerId });
      },
      onChannelClose: () => {
        if (peerRef.current === ps) teardown("Stranger disconnected.", true);
      },
    });
    peerRef.current = ps;
  }

  function handleControl(ctrl: PeerControl) {
    const ps = peerRef.current;
    switch (ctrl) {
      case "video-request":
        if (videoRef.current === "none") setVideo("incoming");
        // Both sides tapped Video at the same moment: treat it as mutual consent
        // rather than leaving each waiting on the other forever.
        else if (videoRef.current === "requesting") acceptVideo();
        break;
      case "video-accept":
        if (videoRef.current === "requesting" && ps) {
          clearVideoTimer();
          ps.startVideo()
            .then((stream) => {
              setLocalStream(stream);
              setVideo("active");
            })
            .catch(() => {
              setVideo("none");
              ps.sendControl("video-end");
              showNotice("Camera unavailable.");
            });
        }
        break;
      case "video-decline":
        if (videoRef.current === "requesting") {
          clearVideoTimer();
          setVideo("none");
          showNotice("Video declined.");
        }
        break;
      case "video-end":
        clearVideoTimer();
        ps?.stopVideo();
        setLocalStream(null);
        setRemoteStream(null);
        setVideo("none");
        break;
    }
  }

  function requestConnection(peerId: string) {
    if (connRef.current.kind !== "idle") return;
    setConn({ kind: "requesting", peerId });
    void sendSignal(sessionId, peerId, "request");
    clearConnTimer();
    connTimer.current = setTimeout(() => {
      if (
        connRef.current.kind === "requesting" &&
        connRef.current.peerId === peerId
      ) {
        teardown("No answer.", true);
      }
    }, REQUEST_TIMEOUT_MS);
  }

  function cancelRequest() {
    teardown(undefined, connRef.current.kind === "requesting");
  }

  function acceptIncoming() {
    if (connRef.current.kind !== "incoming") return;
    const peerId = connRef.current.peerId;
    startPeer(peerId, false);
    void sendSignal(sessionId, peerId, "accept");
    setConn({ kind: "connecting", peerId });
    armConnectTimeout(peerId);
  }

  function declineIncoming() {
    if (connRef.current.kind !== "incoming") return;
    void sendSignal(sessionId, connRef.current.peerId, "decline");
    setConn({ kind: "idle" });
  }

  function endConnection() {
    const c = connRef.current;
    teardown(undefined, c.kind === "connecting" || c.kind === "connected");
  }

  function startVideoRequest() {
    if (videoRef.current !== "none" || !peerRef.current) return;
    setVideo("requesting");
    peerRef.current.sendControl("video-request");
    clearVideoTimer();
    videoTimer.current = setTimeout(() => {
      if (videoRef.current === "requesting") {
        cancelVideoRequest();
        showNotice("No answer to the video request.");
      }
    }, VIDEO_REQUEST_TIMEOUT_MS);
  }

  // Withdraw an unanswered video request; "video-end" closes the stranger's prompt.
  function cancelVideoRequest() {
    if (videoRef.current !== "requesting") return;
    clearVideoTimer();
    peerRef.current?.sendControl("video-end");
    setVideo("none");
  }

  function acceptVideo() {
    const ps = peerRef.current;
    if (!ps) return;
    clearVideoTimer();
    ps.startVideo()
      .then((stream) => {
        setLocalStream(stream);
        ps.sendControl("video-accept");
        setVideo("active");
      })
      .catch(() => {
        ps.sendControl("video-decline");
        setVideo("none");
        showNotice("Camera unavailable.");
      });
  }

  function declineVideo() {
    peerRef.current?.sendControl("video-decline");
    setVideo("none");
  }

  function endVideo() {
    const ps = peerRef.current;
    ps?.stopVideo();
    ps?.sendControl("video-end");
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
  }

  function processSignal(sig: SignalMsg) {
    switch (sig.type) {
      case "request": {
        if (connRef.current.kind === "idle") {
          setConn({ kind: "incoming", peerId: sig.fromId });
        } else {
          void sendSignal(sessionId, sig.fromId, "decline");
        }
        break;
      }
      case "accept": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          startPeer(sig.fromId, true);
          setConn({ kind: "connecting", peerId: sig.fromId });
          armConnectTimeout(sig.fromId);
        }
        break;
      }
      case "decline": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          teardown("Request declined.");
        }
        break;
      }
      case "offer":
      case "answer":
      case "ice": {
        const c = connRef.current;
        const peerId =
          c.kind === "connecting" || c.kind === "connected" ? c.peerId : null;
        if (peerRef.current && peerId === sig.fromId) {
          void peerRef.current.handleSignal(
            sig.type as DescType,
            sig.payload ?? "",
          );
        }
        break;
      }
      case "end": {
        const c = connRef.current;
        if (
          (c.kind === "incoming" ||
            c.kind === "connecting" ||
            c.kind === "connected") &&
          c.peerId === sig.fromId
        ) {
          if (c.kind === "incoming") setConn({ kind: "idle" });
          else teardown("Stranger disconnected.");
        }
        break;
      }
    }
  }

  function handlePoll(data: PollResponse) {
    setPeers(data.peers);
    for (const s of data.signals) processSignal(s);

    // Our own row was reaped (e.g. the tab sat throttled in the background
    // longer than STALE_MS). Re-join so we're visible again instead of being
    // an invisible ghost who can see others but can't be seen or reached.
    if (!data.present && locationRef.current && !rejoining.current) {
      rejoining.current = true;
      const { lat, lng } = locationRef.current;
      join(sessionId, lat, lng)
        .catch(() => {})
        .finally(() => {
          rejoining.current = false;
        });
    }

    // The stranger we're dealing with disappeared from the map (closed the
    // tab, lost network, got reaped) — end things on our side too.
    const c = connRef.current;
    if (c.kind === "idle") {
      missingPolls.current = 0;
      return;
    }
    const present = data.peers.some((p) => p.id === c.peerId);
    missingPolls.current = present ? 0 : missingPolls.current + 1;
    if (missingPolls.current < PEER_GONE_POLLS) return;
    if (c.kind === "incoming") {
      missingPolls.current = 0;
      setConn({ kind: "idle" });
    } else {
      teardown(
        c.kind === "requesting" ? "They went offline." : "Stranger disconnected.",
        true,
      );
    }
  }

  const handlePollRef = useRef(handlePoll);
  useEffect(() => {
    handlePollRef.current = handlePoll;
  });

  useEffect(() => {
    if (phase !== "live" || !sessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const data = await poll(sessionId);
        if (!active) return;
        handlePollRef.current(data);
      } catch {}
      const k = connRef.current.kind;
      const handshaking = k === "requesting" || k === "connecting";
      if (active) {
        timer = setTimeout(tick, handshaking ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
      }
    };
    tick();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [phase, sessionId]);

  useEffect(() => {
    if (!sessionId || phase !== "live") return;
    const onLeave = () => leave(sessionId);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [sessionId, phase]);

  // Throws if the server can't be reached, so the gate can show an error
  // instead of dropping the user onto a map where nothing works.
  async function handleReady(lat: number, lng: number) {
    await join(sessionId, lat, lng);
    locationRef.current = { lat, lng };
    setMyLocation({ lat, lng });
    setPhase("live");
  }

  if (phase === "gate") {
    return <EntryGate onReady={handleReady} />;
  }

  const inChat = conn.kind === "connecting" || conn.kind === "connected";

  return (
    <main className="fixed inset-0 overflow-hidden">
      <WorldMap
        peers={peers}
        me={myLocation}
        onPeerClick={requestConnection}
        canConnect={conn.kind === "idle"}
      />

      {notice && (
        <div className="absolute left-1/2 top-20 z-30 -translate-x-1/2 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          {notice}
        </div>
      )}

      {conn.kind === "requesting" && (
        <div className="absolute left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          <span>Requesting connection…</span>
          <button
            onClick={cancelRequest}
            className="rounded-full bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
          >
            Cancel
          </button>
        </div>
      )}

      {conn.kind === "incoming" && (
        <ConnectionPrompt
          title="A stranger wants to connect"
          acceptLabel="Accept"
          declineLabel="Decline"
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
        />
      )}

      {inChat && (
        <ChatPanel
          messages={messages}
          connected={conn.kind === "connected"}
          videoBusy={video !== "none"}
          onSend={(text) => {
            if (peerRef.current?.sendChat(text)) addMessage(true, text);
            else showNotice("Message not sent — connection lost.");
          }}
          onStartVideo={startVideoRequest}
          onEnd={endConnection}
        />
      )}

      {video === "requesting" && (
        <div className="absolute bottom-24 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          <span>Waiting for stranger to accept video…</span>
          <button
            onClick={cancelVideoRequest}
            className="rounded-full bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
          >
            Cancel
          </button>
        </div>
      )}

      {video === "incoming" && (
        <ConnectionPrompt
          title="Start video call?"
          subtitle="The stranger wants to turn on video."
          acceptLabel="Accept"
          declineLabel="Decline"
          onAccept={acceptVideo}
          onDecline={declineVideo}
        />
      )}

      {video === "active" && (
        <VideoPanel
          localStream={localStream}
          remoteStream={remoteStream}
          onEnd={endVideo}
        />
      )}
    </main>
  );
}
