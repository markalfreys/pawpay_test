// Shared types across client + API.

// Signal mailbox message types.
export type SignalType =
  | "request" // connection request (tap a dot)
  | "accept" // recipient accepted
  | "decline" // recipient declined (or auto-declined while busy)
  | "offer" // WebRTC SDP offer
  | "answer" // WebRTC SDP answer
  | "ice" // WebRTC ICE candidate
  | "end" // hang up / leave the connection
  | "wave" // a quiet hello: no prompt; waving back connects (see app/page.tsx)
  | "unwave"; // the wave between us is off: taken back, or "No thanks"

// A wave in flight with one peer: "out" = we waved at them, "in" = they
// waved at us.
export type WaveDir = "in" | "out";

export interface PeerDot {
  id: string; // public session id — safe to share, can't be used to act as them
  lat: number;
  lng: number;
  busy: boolean;
}

export interface SignalMsg {
  id: string;
  fromId: string;
  toId: string;
  type: SignalType;
  payload: string | null;
  createdAt: string;
}

// Pre-join preview of the globe (anonymous: no ids).
export interface GlobeResponse {
  online: number;
  peers: { lat: number; lng: number; busy: boolean }[];
}

export interface PollResponse {
  // false when the caller's presence row no longer exists → client re-joins.
  present: boolean;
  peers: PeerDot[];
  signals: SignalMsg[];
}
