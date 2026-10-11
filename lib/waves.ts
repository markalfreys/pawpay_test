// Waves on the live map: a comet along the great circle from one dot to
// another, a ripple where it leaves and a double ripple where it lands. The
// same motion as the entry globe's illustrative greetings (lib/ambient.ts),
// but these are real, and only the two people involved ever see one.
import type { GeoJSONSource, Map as MapboxMap } from "mapbox-gl";
import { along, angleDeg, greatCircle, type LngLat } from "@/lib/ambient";

type Wave = { coords: LngLat[]; color: string; start: number; travel: number };

const ARC_POINTS = 64;
const KM_PER_DEG = 111.2;
const LAUNCH_RIPPLE_MS = 700;
const RIPPLE_MS = 1300;
const SECOND_RIPPLE_DELAY_MS = 280;
const LINGER_MS = 1700;
const FRAME_MS = 33; // ~30 fps, like the ambient layer

export type WaveLayer = {
  launch: (from: LngLat, to: LngLat, color: string) => void;
  destroy: () => void;
};

// Keep consecutive longitudes within 180° of each other, so an arc across
// the antimeridian (Fiji → Samoa) is drawn the short way, not round the globe.
function unwrap(coords: LngLat[]): LngLat[] {
  const out: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    let lng = coords[i][0];
    const prev = out[i - 1][0];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    out.push([lng, coords[i][1]]);
  }
  return out;
}

const feature = (
  geometry: GeoJSON.Geometry,
  properties: Record<string, number | string> = {},
): GeoJSON.Feature => ({ type: "Feature", properties, geometry });

export function createWaveLayer(map: MapboxMap): WaveLayer {
  const ids = {
    arcs: "pulse-wave-arcs",
    trails: "pulse-wave-trails",
    ripples: "pulse-wave-ripples",
    heads: "pulse-wave-heads",
  };
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

  for (const id of [ids.arcs, ids.ripples, ids.heads]) {
    map.addSource(id, { type: "geojson", data: empty });
  }
  // lineMetrics enables the gradient along `line-progress`.
  map.addSource(ids.trails, { type: "geojson", data: empty, lineMetrics: true });

  map.addLayer({
    id: ids.arcs,
    type: "line",
    source: ids.arcs,
    paint: {
      "line-color": ["get", "c"],
      "line-width": 1.2,
      "line-dasharray": [1.5, 2],
      "line-opacity": ["*", 0.5, ["get", "o"]],
    },
  });
  map.addLayer({
    id: ids.trails,
    type: "line",
    source: ids.trails,
    layout: { "line-cap": "round" },
    paint: {
      "line-width": 3,
      "line-blur": 0.6,
      // line-gradient can't vary per feature, so every trail uses the brand
      // heartbeat gradient; the head and ripples carry the stranger's colour.
      "line-gradient": [
        "interpolate",
        ["linear"],
        ["line-progress"],
        0,
        "rgba(255, 107, 129, 0)",
        1,
        "rgba(255, 196, 140, 0.95)",
      ],
    },
  });
  map.addLayer({
    id: ids.ripples,
    type: "circle",
    source: ids.ripples,
    paint: {
      "circle-radius": ["get", "r"],
      "circle-color": "rgba(0, 0, 0, 0)",
      "circle-stroke-width": 2,
      "circle-stroke-color": ["get", "c"],
      "circle-stroke-opacity": ["get", "o"],
    },
  });
  map.addLayer({
    id: ids.heads,
    type: "circle",
    source: ids.heads,
    paint: {
      "circle-radius": 4,
      "circle-color": "#fff4e6",
      "circle-opacity": ["get", "o"],
      "circle-stroke-width": 7,
      "circle-stroke-color": ["get", "c"],
      "circle-stroke-opacity": ["*", 0.35, ["get", "o"]],
    },
  });

  const waves: Wave[] = [];
  let raf = 0;
  let lastFrame = 0;

  const set = (id: string, features: GeoJSON.Feature[]) =>
    (map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });

  const ripple = (at: LngLat, color: string, age: number, size: number, out: GeoJSON.Feature[]) => {
    if (age < 0 || age >= 1) return;
    out.push(feature({ type: "Point", coordinates: at }, { r: 4 + size * age, o: 0.9 * (1 - age), c: color }));
  };

  const frame = (now: number) => {
    if (waves.length === 0) {
      raf = 0;
      for (const id of Object.values(ids)) set(id, []);
      return;
    }
    raf = requestAnimationFrame(frame);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;

    const arcF: GeoJSON.Feature[] = [];
    const trailF: GeoJSON.Feature[] = [];
    const headF: GeoJSON.Feature[] = [];
    const rippleF: GeoJSON.Feature[] = [];

    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      const n = w.coords.length;
      // A frame's timestamp marks when the frame began, which can be a hair
      // before a wave launched mid-frame (performance.now()). Negative time
      // would index the arc at -1.
      const elapsed = Math.max(0, now - w.start);
      const after = Math.max(0, elapsed - w.travel);
      if (after > LINGER_MS) {
        waves.splice(i, 1);
        continue;
      }
      const fade = 1 - Math.min(1, after / (LINGER_MS - 300));
      arcF.push(feature({ type: "LineString", coordinates: w.coords }, { o: Math.min(1, elapsed / 300) * fade, c: w.color }));
      ripple(w.coords[0], w.color, elapsed / LAUNCH_RIPPLE_MS, 14, rippleF);

      const end = w.coords[n - 1];
      if (after === 0) {
        const idx = (elapsed / w.travel) * (n - 1);
        const tail = Math.max(0, idx - (n - 1) * 0.25);
        const pts: LngLat[] = [along(w.coords, tail)];
        for (let k = Math.ceil(tail); k < idx; k++) pts.push(w.coords[k]);
        pts.push(along(w.coords, idx));
        if (pts.length >= 2) trailF.push(feature({ type: "LineString", coordinates: pts }));
        headF.push(feature({ type: "Point", coordinates: pts[pts.length - 1] }, { o: 1, c: w.color }));
      } else {
        ripple(end, w.color, after / RIPPLE_MS, 30, rippleF);
        ripple(end, w.color, (after - SECOND_RIPPLE_DELAY_MS) / RIPPLE_MS, 30, rippleF);
        headF.push(feature({ type: "Point", coordinates: end }, { o: Math.max(0, 1 - after / 500), c: w.color }));
      }
    }

    set(ids.arcs, arcF);
    set(ids.trails, trailF);
    set(ids.heads, headF);
    set(ids.ripples, rippleF);
  };

  return {
    launch(from, to, color) {
      const deg = angleDeg(from, to);
      const km = deg * KM_PER_DEG;
      // Two dots in the same spot have no great circle to follow.
      const coords = deg < 1e-4 ? [from, to] : unwrap(greatCircle(from, to, ARC_POINTS));
      waves.push({ coords, color, start: performance.now(), travel: Math.min(2600, 900 + km * 0.25) });
      if (!raf) raf = requestAnimationFrame(frame);
    },
    destroy() {
      cancelAnimationFrame(raf);
      raf = 0;
      waves.length = 0;
      try {
        for (const id of [ids.heads, ids.ripples, ids.trails, ids.arcs]) {
          if (map.getLayer(id)) map.removeLayer(id);
          if (map.getSource(id)) map.removeSource(id);
        }
      } catch {
        // The map itself may already be gone (unmount).
      }
    },
  };
}
