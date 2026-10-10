// How long a presence row survives without a heartbeat (poll). After this the
// dot is treated as offline and removed — implements "dot disappears when the
// user leaves" even if their tab closed without a clean leave.
export const STALE_MS = 15_000;

// Orphan signals (mailbox messages never drained) are cleaned up after this.
export const SIGNAL_TTL_MS = 60_000;

// Client poll interval. Kept here so client + server reason about the same cadence.
export const POLL_INTERVAL_MS = 1_500;

// Faster cadence while a handshake is in flight (request sent, or WebRTC
// connecting). Each signaling hop waits for the next poll, so this is what
// makes "tap → connected" feel quick. Idle users stay on the slow cadence.
export const FAST_POLL_INTERVAL_MS = 400;

// Minimum gap between garbage-collection sweeps on a single server instance.
export const REAP_INTERVAL_MS = 5_000;
