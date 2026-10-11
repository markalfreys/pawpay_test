// Every stranger gets a colour derived from their session id. The same colour
// paints their dot on the map, their orb in prompts and the chat header — so
// "the mint dot near Manila" is recognisably the person asking to talk.
//
// A curated set (rather than any hue) keeps the globe harmonious and every
// colour legible against the dark map.
const PALETTE = [
  "#ff7a8a", // coral
  "#ffb86b", // amber
  "#7cf5c4", // mint
  "#6ee7ff", // sky
  "#a99bff", // lavender
  "#ff8fd8", // orchid
  "#fde68a", // butter
  "#8ef08e", // lime
] as const;

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorFor(id: string): string {
  return PALETTE[hash(id) % PALETTE.length];
}

// Desynchronises the heartbeat animation so the globe shimmers instead of
// blinking in lockstep.
export function beatDelayFor(id: string): string {
  return `${-((hash(id) % 2400) / 1000)}s`;
}
