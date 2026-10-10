// A soft two-note "heartbeat" for incoming requests, synthesised with Web
// Audio (no asset). Browsers only allow audio after a user gesture, so the
// context is primed from the "Enter" click and reused afterwards.
let ctx: AudioContext | null = null;

export function primeChime() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function playChime() {
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  for (const [offset, freq] of [
    [0, 523.25],
    [0.16, 783.99],
  ] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + offset);
    gain.gain.linearRampToValueAtTime(0.07, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.55);
  }
}
