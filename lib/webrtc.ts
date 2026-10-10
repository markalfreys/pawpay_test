export type DescType = "offer" | "answer" | "ice";
export type PeerControl =
  | "video-request"
  | "video-accept"
  | "video-decline"
  | "video-end"
  | "typing" // throttled "I'm typing" ping
  | "cam-off" // sender paused their camera (so the other side can say so
  | "cam-on"; //  instead of showing a frozen black frame)

interface PeerCallbacks {
  onSignal: (type: DescType, payload: string) => void;
  onChat: (text: string) => void;
  onControl: (ctrl: PeerControl) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onChannelOpen: () => void;
  // The data channel closed underneath us (the stranger closed their tab or
  // their peer connection) — the session is over.
  onChannelClose: () => void;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export class PeerSession {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private localStream: MediaStream | null = null;
  private startingVideo: Promise<MediaStream> | null = null;
  private closed = false;
  private readonly cb: PeerCallbacks;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  // Signals are applied strictly one at a time, in arrival order. Without this
  // an ICE candidate can race a still-pending setRemoteDescription().
  private signalChain: Promise<void> = Promise.resolve();

  constructor(initiator: boolean, cb: PeerCallbacks) {
    this.cb = cb;
    this.polite = !initiator;
    this.pc = new RTCPeerConnection(ICE_CONFIG);

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.emitSignal("ice", JSON.stringify(candidate));
      }
    };

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          this.emitSignal("offer", JSON.stringify(this.pc.localDescription));
        }
      } catch (err) {
        if (!this.closed) console.warn("[pulse] negotiation failed", err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.ontrack = ({ streams }) => {
      this.cb.onRemoteStream(streams[0] ?? null);
    };

    this.pc.onconnectionstatechange = () => {
      this.cb.onConnectionState(this.pc.connectionState);
    };

    if (initiator) {
      this.dc = this.pc.createDataChannel("chat");
      this.wireDataChannel(this.dc);
    } else {
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this.wireDataChannel(this.dc);
      };
    }
  }

  private wireDataChannel(dc: RTCDataChannel) {
    dc.onopen = () => this.cb.onChannelOpen();
    dc.onclose = () => {
      if (!this.closed) this.cb.onChannelClose();
    };
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.t === "chat" && typeof msg.text === "string") {
          this.cb.onChat(msg.text);
        } else if (msg.t === "ctrl" && typeof msg.ctrl === "string") {
          this.cb.onControl(msg.ctrl as PeerControl);
        } else if (
          msg.t === "sig" &&
          (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") &&
          typeof msg.payload === "string"
        ) {
          void this.handleSignal(msg.type, msg.payload);
        }
      } catch {}
    };
  }

  // Before the data channel opens, signaling has to go through the server.
  // Once it's open, renegotiation (starting/stopping video, late ICE) goes
  // peer-to-peer over the channel: no poll round trips, and the server never
  // sees those SDPs.
  private emitSignal(type: DescType, payload: string) {
    if (this.closed) return;
    if (!this.safeSend({ t: "sig", type, payload })) {
      this.cb.onSignal(type, payload);
    }
  }

  handleSignal(type: DescType, payload: string): Promise<void> {
    this.signalChain = this.signalChain
      .then(() => this.applySignal(type, payload))
      .catch((err) => {
        if (!this.closed) console.warn("[pulse] signal failed", type, err);
      });
    return this.signalChain;
  }

  private async applySignal(type: DescType, payload: string) {
    if (this.closed) return;
    const data = JSON.parse(payload);

    if (type === "ice") {
      if (!this.pc.remoteDescription) {
        this.pendingCandidates.push(data);
        return;
      }
      try {
        await this.pc.addIceCandidate(data);
      } catch {}
      return;
    }

    const desc = data as RTCSessionDescriptionInit;
    const offerCollision =
      desc.type === "offer" &&
      (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    await this.pc.setRemoteDescription(desc);
    // Candidates can only be added once a remote description exists — flushing
    // them before setRemoteDescription() silently dropped every early one.
    await this.flushPendingCandidates();
    if (this.closed) return;
    if (desc.type === "offer") {
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) {
        this.emitSignal("answer", JSON.stringify(this.pc.localDescription));
      }
    }
  }

  private async flushPendingCandidates() {
    if (this.pendingCandidates.length === 0) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  sendChat(text: string): boolean {
    // Must match the receiver's `msg.t === "chat"` check in wireDataChannel.
    return this.safeSend({ t: "chat", text });
  }

  sendControl(ctrl: PeerControl) {
    this.safeSend({ t: "ctrl", ctrl });
  }

  private safeSend(obj: unknown): boolean {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // Idempotent while a getUserMedia() call is in flight, so two overlapping
  // calls (e.g. both users tapping Video at once) can't add the tracks twice.
  startVideo(): Promise<MediaStream> {
    if (this.localStream) return Promise.resolve(this.localStream);
    this.startingVideo ??= navigator.mediaDevices
      // `video: true` gets 640×480 (4:3) on most webcams: soft, and cropped
      // hard when filling a wide screen. Ask for 720p (16:9) when available.
      .getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      .then((stream) => {
        if (this.closed) {
          for (const track of stream.getTracks()) track.stop();
          throw new Error("session closed");
        }
        this.localStream = stream;
        for (const track of stream.getTracks()) {
          this.pc.addTrack(track, stream);
        }
        return stream;
      })
      .finally(() => {
        this.startingVideo = null;
      });
    return this.startingVideo;
  }

  // Mute / camera toggles flip track.enabled: instant, no renegotiation, and
  // the stranger receives silence / black instead of our media.
  setMicEnabled(on: boolean) {
    for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = on;
  }

  setCameraEnabled(on: boolean) {
    for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = on;
  }

  stopVideo() {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      for (const sender of this.pc.getSenders()) {
        if (sender.track) {
          try {
            this.pc.removeTrack(sender);
          } catch {}
        }
      }
      this.localStream = null;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopVideo();
    if (this.dc) {
      try {
        this.dc.close();
      } catch {}
    }
    try {
      this.pc.close();
    } catch {}
  }
}
