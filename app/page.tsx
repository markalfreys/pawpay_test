"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Hand, Link as LinkIcon, MessageCircle } from "lucide-react";
import EntryGate from "./components/EntryGate";
import WorldMap, { type WorldMapHandle } from "./components/WorldMap";
import ConnectionPrompt from "./components/ConnectionPrompt";
import CallingCard from "./components/CallingCard";
import PeerCard, { distanceLabel } from "./components/PeerCard";
import ChatPanel, { MAX_MESSAGE_LENGTH, type ChatMessage } from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import { LivePill, Toast, Wordmark } from "./components/ui";
import { globe, join, leave, poll, sendSignal } from "@/lib/api";
import { PeerSession, type DescType, type PeerControl } from "@/lib/webrtc";
import { FAST_POLL_INTERVAL_MS, POLL_INTERVAL_MS } from "@/lib/presence";
import { colorFor } from "@/lib/palette";
import { playChime } from "@/lib/chime";
import { distanceKm } from "@/lib/geo";
import { type PeerDot, type PollResponse, type SignalMsg, type WaveDir } from "@/lib/types";

type Conn =
  | { kind: "idle" }
  // `viaWave`: we're waving back, so they already said hi and will accept.
  | { kind: "requesting"; peerId: string; viaWave?: boolean }
  | { kind: "incoming"; peerId: string }
  | { kind: "connecting"; peerId: string }
  | { kind: "connected"; peerId: string };

type VideoState = "none" | "requesting" | "incoming" | "active";

type LngLat = { lat: number; lng: number };

const REQUEST_TIMEOUT_MS = 30_000;
// Accepted but the WebRTC data channel never opened (peer vanished mid-handshake,
// or the network blocks P2P). Without this the chat sat on "Connecting…" forever.
const CONNECT_TIMEOUT_MS = 25_000;
const VIDEO_REQUEST_TIMEOUT_MS = 30_000;
// The partner's dot must be missing from this many consecutive polls before we
// treat them as gone (one miss can be a transient read).
const PEER_GONE_POLLS = 2;
const GLOBE_PREVIEW_INTERVAL_MS = 5_000;
const TYPING_SEND_INTERVAL_MS = 2_500;
const TYPING_SHOW_MS = 4_000;
const GATE_FADE_MS = 700;
// How long a wave stays up before it quietly fades.
const WAVE_TTL_MS = 120_000;
// The receiver's copy of a wave expires this much earlier than the sender's.
const WAVE_GRACE_MS = 10_000;
const BOTH_WAVED = "You both waved 👋 Say hello!";

// Waves: a quiet hello. Tapping a dot offers "Wave" next to "Ask to chat". A
// wave flies across the globe and lands on their dot with no prompt, no chime
// and no pressure. If they wave back, you're connected: both of you said hi,
// so nobody has to accept anything. Under the hood, waving back is a normal
// request, and the waver's client accepts it automatically. Unanswered waves
// fade after WAVE_TTL_MS. "No thanks" turns down that wave (the sender can
// try again later); "Block this person" ignores their waves and requests for
// the rest of the session.
type Wave = { dir: WaveDir; expires: number; closed?: boolean };

type EndOptions = {
  // Toast to show once torn down.
  notice?: string;
  // Send "end" so the server frees both busy flags and the stranger's UI closes.
  notifyPeer?: boolean;
  // The *other side* ended an open chat: keep the transcript on screen
  // (read-only) with this reason instead of yanking it away mid-sentence.
  keepTranscript?: string;
};

export default function Home() {
  const [phase, setPhase] = useState<"gate" | "live">("gate");
  const [gateMounted, setGateMounted] = useState(true);
  const [preview, setPreview] = useState<PeerDot[]>([]);
  // This tab's secret session key: our credential for every API call. Others
  // only ever see the public id the server derives from it.
  const [sessionKey] = useState(() => crypto.randomUUID());
  const [peers, setPeers] = useState<PeerDot[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ended, setEnded] = useState<{ peerId: string; reason: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteCamOff, setRemoteCamOff] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [typing, setTyping] = useState(false);
  // Where everyone else sees us (the server's offset position).
  const [publicMe, setPublicMe] = useState<LngLat | null>(null);
  const [hasTapped, setHasTapped] = useState(false);
  const [copied, setCopied] = useState(false);

  // The dot whose card is open (the user tapped it).
  const [selected, setSelected] = useState<string | null>(null);

  const [conn, _setConn] = useState<Conn>({ kind: "idle" });
  const connRef = useRef<Conn>(conn);
  const setConn = (c: Conn) => {
    connRef.current = c;
    _setConn(c);
    if (c.kind !== "idle") setSelected(null);
  };

  // Waves in flight, by peer id. `closed`: the user dismissed the card for an
  // incoming wave without answering (the badge stays on the dot).
  const [waves, _setWaves] = useState<Record<string, Wave>>({});
  const wavesRef = useRef(waves);
  const setWaves = (w: Record<string, Wave>) => {
    wavesRef.current = w;
    _setWaves(w);
  };
  // People we blocked: their waves and requests are ignored.
  const mutedRef = useRef<Set<string>>(new Set());
  // Our own public id, to break the tie when two people wave at each other.
  const myIdRef = useRef<string | null>(null);
  const mapRef = useRef<WorldMapHandle>(null);

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
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);
  // The user's real coordinates — kept only in memory, for re-joining.
  const locationRef = useRef<LngLat | null>(null);
  const missingPolls = useRef(0);
  const rejoining = useRef(false);

  function showNotice(text: string) {
    setNotice(text);
    // Reset the timer so a newer notice isn't cleared early by an older one.
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3800);
  }

  function addMessage(mine: boolean, text: string) {
    setMessages((prev) => [...prev, { id: msgId.current++, mine, text, at: Date.now() }]);
  }

  function addSystem(text: string) {
    setMessages((prev) => [
      ...prev,
      { id: msgId.current++, mine: false, text, at: Date.now(), system: true },
    ]);
  }

  function clearConnTimer() {
    if (connTimer.current) clearTimeout(connTimer.current);
    connTimer.current = null;
  }

  function clearVideoTimer() {
    if (videoTimer.current) clearTimeout(videoTimer.current);
    videoTimer.current = null;
  }

  function clearTyping() {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    setTyping(false);
  }

  function resetMedia() {
    setLocalStream(null);
    setRemoteStream(null);
    setRemoteCamOff(false);
    setMicOn(true);
    setCamOn(true);
  }

  // Starting a new conversation clears whatever ended one was still on screen.
  function freshConversation() {
    setEnded(null);
    setMessages([]);
  }

  // Ends the current connection locally. With `notifyPeer`, also sends "end"
  // so the server frees both busy flags and the stranger's UI closes too —
  // previously local failures (network, timeouts) never told the server, so
  // the user stayed "busy" on everyone's map.
  function teardown({ notice, notifyPeer = false, keepTranscript }: EndOptions = {}) {
    const c = connRef.current;
    if (notifyPeer && c.kind !== "idle") {
      void sendSignal(sessionKey, c.peerId, "end");
    }
    clearConnTimer();
    clearVideoTimer();
    clearTyping();
    missingPolls.current = 0;
    peerRef.current?.close();
    peerRef.current = null;
    resetMedia();
    setVideo("none");
    if (keepTranscript && c.kind === "connected") {
      setEnded({ peerId: c.peerId, reason: keepTranscript });
    } else {
      freshConversation();
      if (keepTranscript) showNotice(keepTranscript);
    }
    setConn({ kind: "idle" });
    if (notice) showNotice(notice);
  }

  function armConnectTimeout(peerId: string) {
    clearConnTimer();
    connTimer.current = setTimeout(() => {
      const c = connRef.current;
      if (c.kind === "connecting" && c.peerId === peerId) {
        teardown({
          notice: "Couldn't connect — some networks block direct connections. Try someone else?",
          notifyPeer: true,
        });
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function startPeer(peerId: string, initiator: boolean) {
    const ps = new PeerSession(initiator, {
      onSignal: (type: DescType, payload: string) => {
        void sendSignal(sessionKey, peerId, type, payload);
      },
      onChat: (text) => {
        if (typingTimer.current) clearTimeout(typingTimer.current);
        setTyping(false);
        addMessage(false, text);
      },
      onControl: (ctrl) => handleControl(ctrl),
      onRemoteStream: (stream) => setRemoteStream(stream),
      onConnectionState: (state) => {
        if (state === "failed" && peerRef.current === ps) {
          teardown({ keepTranscript: "The connection dropped.", notifyPeer: true });
        }
      },
      onChannelOpen: () => {
        clearConnTimer();
        setConn({ kind: "connected", peerId });
      },
      onChannelClose: () => {
        if (peerRef.current === ps) {
          teardown({ keepTranscript: "Stranger left the chat.", notifyPeer: true });
        }
      },
    });
    peerRef.current = ps;
  }

  function videoStarted(stream: MediaStream) {
    setLocalStream(stream);
    setMicOn(true);
    setCamOn(true);
    setVideo("active");
    addSystem("Video call started");
  }

  function videoStopped() {
    clearVideoTimer();
    peerRef.current?.stopVideo();
    resetMedia();
    if (videoRef.current === "active") addSystem("Video call ended");
    setVideo("none");
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
            .then(videoStarted)
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
          showNotice("They'd rather keep it to text for now.");
        }
        break;
      case "video-end":
        videoStopped();
        break;
      case "typing":
        setTyping(true);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTyping(false), TYPING_SHOW_MS);
        break;
      case "cam-off":
        setRemoteCamOff(true);
        break;
      case "cam-on":
        setRemoteCamOff(false);
        break;
    }
  }

  // An incoming wave expires a little before the sender's copy, so waving
  // back never reaches someone whose wave has just run out (they'd get a
  // full prompt while we were told "you both said hi").
  function putWave(peerId: string, dir: WaveDir) {
    const ttl = dir === "in" ? WAVE_TTL_MS - WAVE_GRACE_MS : WAVE_TTL_MS;
    setWaves({ ...wavesRef.current, [peerId]: { dir, expires: Date.now() + ttl } });
  }

  function dropWave(peerId: string) {
    if (!(peerId in wavesRef.current)) return;
    const next = { ...wavesRef.current };
    delete next[peerId];
    setWaves(next);
  }

  // Once we're talking to someone, nobody else's wave-back should connect
  // without a prompt later on. (Their side drops our wave too: see the
  // busy check in handlePoll.)
  function dropOutgoingWaves() {
    const current = Object.entries(wavesRef.current);
    const next = current.filter(([, w]) => w.dir !== "out");
    if (next.length !== current.length) setWaves(Object.fromEntries(next));
  }

  // Tapping a dot opens its card; the card offers wave / ask to chat. It also
  // closes a finished chat's transcript (which would hide the card), as
  // tapping always did.
  function selectPeer(peerId: string) {
    if (connRef.current.kind !== "idle") return;
    if (ended) freshConversation();
    setHasTapped(true);
    setSelected(peerId);
  }

  async function waveAt(peerId: string) {
    if (connRef.current.kind !== "idle") return;
    // Reaching out yourself overrides an earlier "No thanks".
    mutedRef.current.delete(peerId);
    const existing = wavesRef.current[peerId];
    if (existing?.dir === "in") return waveBack(peerId);
    if (existing?.dir === "out") return;
    putWave(peerId, "out");
    mapRef.current?.launchWave("me", peerId);
    const status = await sendSignal(sessionKey, peerId, "wave");
    if (status === 200) return;
    dropWave(peerId);
    showNotice(
      status === 429
        ? "That's a lot of waving. Give it a minute."
        : status === 0
          ? "Couldn't send your wave. Check your connection."
          : "They just got busy. Try someone else?",
    );
  }

  // They waved first, so waving back connects straight away.
  function waveBack(peerId: string) {
    if (connRef.current.kind !== "idle") return;
    dropWave(peerId);
    mapRef.current?.launchWave("me", peerId);
    requestConnection(peerId, true);
  }

  function askToChat(peerId: string) {
    dropWave(peerId);
    requestConnection(peerId);
  }

  // Turn down this wave. Their side clears it too, so they're free to try
  // again later (the server limits how often).
  function noThanks(peerId: string) {
    void sendSignal(sessionKey, peerId, "unwave");
    dropWave(peerId);
    if (selected === peerId) setSelected(null);
  }

  // A "no" that sticks: no more waves or requests from them this session
  // (unless you reach out to them yourself later).
  function block(peerId: string) {
    mutedRef.current.add(peerId);
    noThanks(peerId);
    showNotice("Blocked. You won't hear from them again this session.");
  }

  // Withdraw a wave; their card for it goes away too.
  function takeBack(peerId: string) {
    void sendSignal(sessionKey, peerId, "unwave");
    dropWave(peerId);
    if (selected === peerId) setSelected(null);
  }

  // Closing an incoming wave's card keeps the wave (the 👋 stays on their
  // dot). If it had covered a "You waved" card, that one comes back.
  function closeCard(peerId: string) {
    if (selected === peerId) setSelected(null);
    const w = wavesRef.current[peerId];
    if (w?.dir === "in") setWaves({ ...wavesRef.current, [peerId]: { ...w, closed: true } });
  }

  function requestConnection(peerId: string, viaWave = false) {
    if (connRef.current.kind !== "idle") return;
    mutedRef.current.delete(peerId);
    freshConversation();
    setHasTapped(true);
    setConn({ kind: "requesting", peerId, viaWave });
    // A rejected request (rate limit, or our row was just reaped) never
    // reaches them: say so now instead of "Calling…" for 30 s.
    void sendSignal(sessionKey, peerId, "request").then((status) => {
      if (status === 200) return;
      const c = connRef.current;
      if (c.kind !== "requesting" || c.peerId !== peerId) return;
      teardown({
        notice:
          status === 429
            ? "That's a lot of requests. Give it a minute."
            : "Couldn't reach them. Try again in a moment.",
      });
    });
    clearConnTimer();
    connTimer.current = setTimeout(() => {
      if (
        connRef.current.kind === "requesting" &&
        connRef.current.peerId === peerId
      ) {
        teardown({ notice: "No answer — maybe try someone else?", notifyPeer: true });
      }
    }, REQUEST_TIMEOUT_MS);
  }

  function cancelRequest() {
    teardown({ notifyPeer: connRef.current.kind === "requesting" });
  }

  function acceptIncoming() {
    if (connRef.current.kind !== "incoming") return;
    acceptFrom(connRef.current.peerId);
  }

  function acceptFrom(peerId: string, viaWave = false) {
    freshConversation();
    dropOutgoingWaves();
    startPeer(peerId, false);
    // The server refuses an accept when they've already given up (cancelled
    // or timed out). Say so instead of "Connecting…" until the timeout.
    void sendSignal(sessionKey, peerId, "accept").then((status) => {
      if (status === 200) return;
      const c = connRef.current;
      if (c.kind !== "connecting" || c.peerId !== peerId) return;
      teardown({
        notice:
          status === 0
            ? "Couldn't reach Pulse. Check your connection."
            : "They're no longer waiting.",
      });
    });
    setConn({ kind: "connecting", peerId });
    armConnectTimeout(peerId);
    if (viaWave) addSystem(BOTH_WAVED);
  }

  function declineIncoming() {
    if (connRef.current.kind !== "incoming") return;
    void sendSignal(sessionKey, connRef.current.peerId, "decline");
    setConn({ kind: "idle" });
  }

  function endConnection() {
    const c = connRef.current;
    teardown({ notifyPeer: c.kind === "connecting" || c.kind === "connected" });
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
        ps.sendControl("video-accept");
        videoStarted(stream);
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
    peerRef.current?.sendControl("video-end");
    videoStopped();
  }

  function toggleMic() {
    const on = !micOn;
    peerRef.current?.setMicEnabled(on);
    setMicOn(on);
  }

  function toggleCam() {
    const on = !camOn;
    peerRef.current?.setCameraEnabled(on);
    peerRef.current?.sendControl(on ? "cam-on" : "cam-off");
    setCamOn(on);
  }

  function sendMessage(text: string) {
    const clipped = text.slice(0, MAX_MESSAGE_LENGTH);
    if (peerRef.current?.sendChat(clipped)) {
      addMessage(true, clipped);
      // Next keystroke starts a fresh "typing…" burst on their side.
      lastTypingSent.current = 0;
    } else {
      showNotice("Message not sent — connection lost.");
    }
  }

  // Throttled: at most one "typing" ping every couple of seconds.
  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_INTERVAL_MS) return;
    lastTypingSent.current = now;
    peerRef.current?.sendControl("typing");
  }

  function closeEndedChat() {
    freshConversation();
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showNotice(window.location.origin);
    }
  }

  function processSignal(sig: SignalMsg) {
    switch (sig.type) {
      case "request": {
        const from = sig.fromId;
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === from) {
          // We asked each other at the same moment: a wave back crossing an
          // "Ask to chat", or two waves noticed at once. Both said yes, so
          // connect instead of each declining the other: the lower id's
          // request stands and the other side accepts it.
          const me = myIdRef.current;
          if (me && me > from) acceptFrom(from, c.viaWave);
          break;
        }
        if (c.kind !== "idle" || mutedRef.current.has(from)) {
          void sendSignal(sessionKey, from, "decline");
        } else if (wavesRef.current[from]?.dir === "out") {
          // We waved and they waved back: both said hi, so no prompt.
          dropWave(from);
          mapRef.current?.launchWave(from, "me");
          acceptFrom(from, true);
        } else {
          // A direct ask replaces any wave of theirs.
          dropWave(from);
          setConn({ kind: "incoming", peerId: from });
        }
        break;
      }
      case "accept": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          startPeer(sig.fromId, true);
          setConn({ kind: "connecting", peerId: sig.fromId });
          armConnectTimeout(sig.fromId);
          dropOutgoingWaves();
          if (c.viaWave) addSystem(BOTH_WAVED);
        }
        break;
      }
      case "wave": {
        const from = sig.fromId;
        if (mutedRef.current.has(from)) break;
        const c = connRef.current;
        // Already asking or talking to them: the wave adds nothing (and
        // would come back as a stale card once the chat ends).
        if (c.kind !== "idle" && c.peerId === from) break;
        mapRef.current?.launchWave(from, "me");
        if (wavesRef.current[from]?.dir === "out" && c.kind === "idle") {
          // We waved at each other at the same moment. Both sides ask, and
          // the crossing requests resolve in case "request".
          dropWave(from);
          requestConnection(from, true);
          break;
        }
        // Otherwise it waits on their dot, including when we're busy right
        // now, so a wave never gets lost.
        putWave(from, "in");
        break;
      }
      case "unwave": {
        // They took their wave back, or said no thanks to ours. Either way
        // the wave between us is gone; if it was ours, we can try again later.
        const w = wavesRef.current[sig.fromId];
        if (!w) break;
        dropWave(sig.fromId);
        if (w.dir === "out") showNotice("They can't talk right now.");
        break;
      }
      case "decline": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          teardown({ notice: "They can't talk right now." });
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
          else teardown({ keepTranscript: "Stranger left the chat." });
        }
        break;
      }
    }
  }

  function handlePoll(data: PollResponse) {
    setPeers(data.peers);
    for (const s of data.signals) processSignal(s);

    // Waves fade after their TTL. A wave from someone who has since started
    // another conversation is void: they dropped it on their side when they
    // connected. Someone briefly missing from a poll keeps their wave (one
    // miss can be a transient read; cards and badges only show for people
    // on the map anyway).
    const now = Date.now();
    const online = new Map(data.peers.map((p) => [p.id, p]));
    const current = Object.entries(wavesRef.current);
    const live = current.filter(
      ([id, w]) => w.expires > now && !(w.dir === "in" && online.get(id)?.busy),
    );
    if (live.length !== current.length) setWaves(Object.fromEntries(live));
    // Close the card of someone who left or got busy.
    if (selected) {
      const p = online.get(selected);
      if (!p || p.busy) setSelected(null);
    }

    // Our own row was reaped (e.g. the tab sat throttled in the background
    // longer than STALE_MS). Re-join so we're visible again instead of being
    // an invisible ghost who can see others but can't be seen or reached.
    if (!data.present && locationRef.current && !rejoining.current) {
      rejoining.current = true;
      const { lat, lng } = locationRef.current;
      join(sessionKey, lat, lng)
        .then(({ id, lat, lng }) => {
          myIdRef.current = id;
          setPublicMe({ lat, lng });
        })
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
    } else if (c.kind === "requesting") {
      teardown({ notice: "They went offline.", notifyPeer: true });
    } else {
      teardown({ keepTranscript: "Stranger went offline.", notifyPeer: true });
    }
  }

  const handlePollRef = useRef(handlePoll);
  useEffect(() => {
    handlePollRef.current = handlePoll;
  });

  // Gate: a live, anonymous preview of who's on the globe right now.
  useEffect(() => {
    if (phase !== "gate") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const g = await globe();
        if (!active) return;
        // Key by (rounded) position: stable for a person's whole session, so
        // dots don't reshuffle between refreshes.
        const byPos = new Map<string, PeerDot>();
        for (const p of g.peers) {
          const id = `preview:${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
          byPos.set(id, { id, ...p });
        }
        setPreview([...byPos.values()]);
      } catch {}
      if (active) timer = setTimeout(tick, GLOBE_PREVIEW_INTERVAL_MS);
    };
    tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "live" || !sessionKey) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const data = await poll(sessionKey);
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
  }, [phase, sessionKey]);

  useEffect(() => {
    if (!sessionKey || phase !== "live") return;
    const onLeave = () => leave(sessionKey);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [sessionKey, phase]);

  // Someone's asking (to connect, or to start video): chime, buzz on phones,
  // and flag the tab title in case Pulse is in a background tab.
  const asking = conn.kind === "incoming" || video === "incoming";
  useEffect(() => {
    if (!asking) return;
    playChime();
    navigator.vibrate?.(120);
    const original = document.title;
    document.title = "● Someone wants to talk — Pulse";
    return () => {
      document.title = original;
    };
  }, [asking]);

  // Throws if the server can't be reached, so the gate can show an error
  // instead of dropping the user onto a map where nothing works.
  async function handleReady(lat: number, lng: number) {
    const pub = await join(sessionKey, lat, lng);
    locationRef.current = { lat, lng };
    myIdRef.current = pub.id;
    setPublicMe({ lat: pub.lat, lng: pub.lng });
    setPhase("live");
    // Keep the gate mounted while it fades out over the camera fly-in.
    setTimeout(() => setGateMounted(false), GATE_FADE_MS);
  }

  const inChat = conn.kind === "connecting" || conn.kind === "connected";
  const chatOpen = inChat || ended !== null;
  const chatPeerId = inChat ? conn.peerId : (ended?.peerId ?? null);

  // The card at the bottom: the dot the user tapped, or else a wave they
  // haven't answered or closed, from someone on the map and free. Oldest
  // first, so a wave arriving later never swaps the card out from under a
  // click. A "You waved" card is only waiting, so an incoming wave takes its
  // place (it comes back afterwards; PeerCard briefly ignores clicks on a
  // card that appeared on its own). Only while idle on the map.
  const onMap = phase === "live" && conn.kind === "idle" && !chatOpen;
  const nextWave = Object.entries(waves)
    .filter(
      ([id, w]) => w.dir === "in" && !w.closed && peers.some((p) => p.id === id && !p.busy),
    )
    .sort(([, a], [, b]) => a.expires - b.expires)[0]?.[0];
  const waiting = selected !== null && waves[selected]?.dir === "out";
  const cardId = onMap
    ? ((waiting ? nextWave : undefined) ?? selected ?? nextWave ?? null)
    : null;
  const cardPeer = cardId ? peers.find((p) => p.id === cardId) : undefined;
  const cardWave = cardId ? waves[cardId] : undefined;
  const away = cardPeer && publicMe ? distanceLabel(distanceKm(publicMe, cardPeer)) : "";

  const highlightId = conn.kind !== "idle" ? conn.peerId : cardPeer ? cardPeer.id : null;
  const others = peers.length;
  const showHint = onMap && !cardPeer && (others === 0 || !hasTapped);

  return (
    <main data-phase={phase} className="fixed inset-0 overflow-hidden bg-bg text-ink">
      <WorldMap
        ref={mapRef}
        mode={phase}
        peers={phase === "live" ? peers : preview}
        me={phase === "live" ? publicMe : null}
        highlightId={highlightId}
        waves={waves}
        onPeerClick={selectPeer}
        canConnect={conn.kind === "idle"}
        chatOpen={chatOpen}
      />

      {gateMounted && (
        <EntryGate onReady={handleReady} leaving={phase === "live"} />
      )}

      {phase === "live" && (
        <header className="animate-fade pointer-events-none absolute left-4 top-[calc(1rem+var(--safe-top))] z-10 md:left-6 md:top-6">
          <div className="glass pointer-events-auto inline-flex items-center gap-2 rounded-full py-1.5 pl-4 pr-1.5">
            <Wordmark />
            <LivePill
              online={others + 1}
              label={others === 0 ? "Just you" : `${others + 1} online`}
              className="bg-white/[0.06]"
            />
          </div>
        </header>
      )}

      {showHint && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(2.75rem+var(--safe-bottom))] z-10 flex justify-center px-4 md:bottom-8">
          <div
            className="glass animate-rise pointer-events-auto flex items-center gap-3 rounded-full py-2 pl-4 pr-2 text-sm"
            style={{ animationDelay: "1.2s" }}
          >
            {others === 0 ? (
              <>
                <span className="text-muted">You&rsquo;re the only one here right now.</span>
                <button type="button" onClick={copyInvite} className="btn btn-ghost h-8 px-3 text-xs">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <LinkIcon className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Invite someone"}
                </button>
              </>
            ) : (
              <span className="pr-2 text-ink/90">Tap a glowing dot to say hi</span>
            )}
          </div>
        </div>
      )}

      {notice && <Toast key={notice} text={notice} />}

      {cardPeer && (
        <PeerCard
          key={`${cardPeer.id}:${cardWave?.dir ?? "none"}`}
          color={colorFor(cardPeer.id)}
          autoFocus={cardPeer.id === selected}
          expiresAt={cardWave?.expires}
          ttlMs={cardWave ? WAVE_TTL_MS : undefined}
          onClose={() => closeCard(cardPeer.id)}
          {...(cardWave?.dir === "in"
            ? {
                title: "Someone waved at you 👋",
                subtitle: away,
                hint: "Wave back and you're talking.",
                primary: {
                  label: "Wave back",
                  icon: <Hand className="h-4 w-4" />,
                  onClick: () => waveBack(cardPeer.id),
                },
                secondary: { label: "No thanks", onClick: () => noThanks(cardPeer.id) },
                extra: { label: "Block this person", onClick: () => block(cardPeer.id) },
              }
            : cardWave?.dir === "out"
              ? {
                  title: "You waved 👋",
                  subtitle: "If they wave back, you're talking",
                  secondary: { label: "Take it back", onClick: () => takeBack(cardPeer.id) },
                  primary: {
                    label: "Ask to chat",
                    icon: <MessageCircle className="h-4 w-4" />,
                    onClick: () => askToChat(cardPeer.id),
                    quiet: true,
                  },
                }
              : {
                  title: "Say hi",
                  subtitle: away,
                  hint: "A wave is a quiet hello, with no pop-up on their side. If they wave back, you're talking.",
                  primary: {
                    label: "Wave",
                    icon: <Hand className="h-4 w-4" />,
                    onClick: () => void waveAt(cardPeer.id),
                  },
                  secondary: {
                    label: "Ask to chat",
                    icon: <MessageCircle className="h-4 w-4" />,
                    onClick: () => askToChat(cardPeer.id),
                  },
                })}
        />
      )}

      {conn.kind === "requesting" && (
        <CallingCard
          color={colorFor(conn.peerId)}
          title={conn.viaWave ? "Waving back…" : "Calling…"}
          subtitle={conn.viaWave ? "They said hi first. Connecting…" : "Waiting for them to say yes"}
          onCancel={cancelRequest}
          timeoutMs={REQUEST_TIMEOUT_MS}
        />
      )}

      {conn.kind === "incoming" && (
        <ConnectionPrompt
          key={conn.peerId}
          title="Someone wants to connect"
          subtitle="Accept to open a private chat — just the two of you, peer to peer."
          acceptLabel="Accept"
          declineLabel="Not now"
          color={colorFor(conn.peerId)}
          expiresInMs={REQUEST_TIMEOUT_MS - 2_000}
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
        />
      )}

      {chatOpen && chatPeerId && (
        <ChatPanel
          messages={messages}
          status={conn.kind === "connected" ? "connected" : inChat ? "connecting" : "ended"}
          endedReason={ended?.reason}
          color={colorFor(chatPeerId)}
          typing={typing}
          videoBusy={video !== "none"}
          videoRequesting={video === "requesting"}
          onSend={sendMessage}
          onTyping={notifyTyping}
          onStartVideo={startVideoRequest}
          onCancelVideo={cancelVideoRequest}
          onEnd={endConnection}
          onClose={closeEndedChat}
        />
      )}

      {video === "incoming" && chatPeerId && (
        <ConnectionPrompt
          kind="video"
          title="Video call?"
          subtitle="The stranger wants to turn on video. Your camera stays off unless you accept."
          acceptLabel="Accept"
          declineLabel="Not now"
          color={colorFor(chatPeerId)}
          onAccept={acceptVideo}
          onDecline={declineVideo}
        />
      )}

      {video === "active" && chatPeerId && (
        <VideoPanel
          localStream={localStream}
          remoteStream={remoteStream}
          remoteCameraOff={remoteCamOff}
          micOn={micOn}
          camOn={camOn}
          color={colorFor(chatPeerId)}
          onToggleMic={toggleMic}
          onToggleCam={toggleCam}
          onEnd={endVideo}
        />
      )}
    </main>
  );
}
