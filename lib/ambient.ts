// The entry globe's "the world is alive" layer — purely illustrative.
//
// Tiny twinkling city lights (around real population centres) plus the odd
// "message" crossing the globe: a comet along a great-circle arc, a ripple
// and a little greeting where it lands. It is NOT user data: these points
// are much smaller than the heartbeat dots of real people online, never
// clickable, and the whole layer is removed the moment you enter the live
// map.
import type { GeoJSONSource, Map as MapboxMap, Marker } from "mapbox-gl";

type MapboxGL = typeof import("mapbox-gl").default;
export type LngLat = [number, number];

// [lng, lat] of ~140 large cities, so the lights sit where people live.
const CITIES: LngLat[] = [
  // North & Central America
  [-74.0, 40.7], [-118.2, 34.1], [-87.6, 41.9], [-79.4, 43.7], [-123.1, 49.3],
  [-99.1, 19.4], [-95.4, 29.8], [-80.2, 25.8], [-122.4, 37.8], [-122.3, 47.6],
  [-73.6, 45.5], [-84.4, 33.7], [-96.8, 32.8], [-105.0, 39.7], [-77.0, 38.9],
  [-71.1, 42.4], [-112.1, 33.4], [-103.3, 20.7], [-100.3, 25.7], [-82.4, 23.1],
  [-79.5, 9.0], [-90.5, 14.6], [-66.1, 18.5], [-157.9, 21.3],
  // South America
  [-46.6, -23.5], [-43.2, -22.9], [-58.4, -34.6], [-77.0, -12.0], [-74.1, 4.7],
  [-70.7, -33.4], [-66.9, 10.5], [-78.5, -0.2], [-75.6, 6.2], [-56.2, -34.9],
  [-47.9, -15.8], [-38.5, -13.0], [-38.5, -3.7], [-68.1, -16.5], [-57.6, -25.3],
  // Europe
  [-0.1, 51.5], [2.35, 48.86], [13.4, 52.5], [-3.7, 40.4], [12.5, 41.9],
  [4.9, 52.4], [2.17, 41.39], [-9.14, 38.7], [-6.26, 53.35], [18.07, 59.33],
  [10.75, 59.91], [12.57, 55.68], [21.0, 52.23], [14.42, 50.08], [16.37, 48.21],
  [19.04, 47.5], [23.73, 37.98], [28.98, 41.0], [30.52, 50.45], [37.62, 55.75],
  [24.94, 60.17], [11.58, 48.14], [9.19, 45.46], [-2.24, 53.48], [4.35, 50.85],
  [8.54, 47.37], [26.1, 44.43], [30.3, 59.94],
  // Africa
  [31.24, 30.04], [3.38, 6.52], [36.82, -1.29], [28.05, -26.2], [18.42, -33.92],
  [-7.59, 33.57], [-0.19, 5.6], [38.75, 9.03], [15.27, -4.44], [-17.44, 14.69],
  [3.06, 36.75], [10.18, 36.8], [39.28, -6.79], [13.23, -8.84], [32.56, 15.5],
  [-4.0, 5.36], [32.58, 0.35],
  // Middle East & Central Asia
  [55.27, 25.2], [46.68, 24.71], [51.39, 35.69], [44.36, 33.31], [34.78, 32.09],
  [51.53, 25.29], [67.0, 24.86], [74.36, 31.55], [69.2, 34.55], [69.24, 41.3],
  [76.9, 43.24],
  // South Asia
  [77.2, 28.61], [72.88, 19.08], [77.59, 12.97], [88.36, 22.57], [80.27, 13.08],
  [78.49, 17.39], [90.41, 23.81], [85.32, 27.72], [79.86, 6.93],
  // East & South-East Asia
  [139.69, 35.68], [135.5, 34.69], [126.98, 37.57], [116.4, 39.9], [121.47, 31.23],
  [113.26, 23.13], [114.06, 22.54], [114.17, 22.32], [121.56, 25.03], [104.07, 30.57],
  [114.31, 30.59], [120.98, 14.6], [123.89, 10.32], [125.61, 7.07], [100.5, 13.76],
  [106.63, 10.82], [105.85, 21.03], [101.69, 3.14], [103.82, 1.35], [106.85, -6.21],
  [112.75, -7.25], [96.16, 16.87], [104.92, 11.56], [106.92, 47.92], [141.35, 43.06],
  [129.08, 35.18],
  // Oceania
  [151.21, -33.87], [144.96, -37.81], [153.03, -27.47], [115.86, -31.95],
  [174.76, -36.85], [138.6, -34.93], [147.18, -9.44], [178.44, -18.14],
];

const GREETINGS = [
  "hi! 👋", "hola", "bonjour", "こんにちは", "안녕하세요", "ciao", "olá", "hallo",
  "namaste", "merhaba", "salaam", "hej", "kumusta", "привет", "你好", "jambo",
  "xin chào", "สวัสดี", "sawubona", "hey :)", "kia ora", "aloha",
];

const RAD = Math.PI / 180;
const KM_PER_DEG = 111.2;

// Small deterministic PRNG so the lights are the same on every visit.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;

function buildLights(): LngLat[] {
  const rand = mulberry32(20261010);
  const out: LngLat[] = [];
  for (const [lng, lat] of CITIES) {
    const n = 3 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const r = Math.sqrt(rand()) * 1.2;
      const a = rand() * Math.PI * 2;
      out.push([wrapLng(lng + (r * Math.cos(a)) / Math.cos(lat * RAD)), lat + r * Math.sin(a)]);
    }
  }
  return out;
}

type Vec = [number, number, number];
const toVec = ([lng, lat]: LngLat): Vec => [
  Math.cos(lat * RAD) * Math.cos(lng * RAD),
  Math.cos(lat * RAD) * Math.sin(lng * RAD),
  Math.sin(lat * RAD),
];
const toLngLat = ([x, y, z]: Vec): LngLat => [
  Math.atan2(y, x) / RAD,
  Math.asin(Math.max(-1, Math.min(1, z))) / RAD,
];
export const angleDeg = (a: LngLat, b: LngLat) => {
  const [ax, ay, az] = toVec(a);
  const [bx, by, bz] = toVec(b);
  return Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz))) / RAD;
};

// Points along the great circle from a to b (spherical interpolation).
export function greatCircle(a: LngLat, b: LngLat, n: number): LngLat[] {
  const va = toVec(a);
  const vb = toVec(b);
  const omega = angleDeg(a, b) * RAD;
  const s = Math.sin(omega);
  const pts: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const ka = Math.sin((1 - t) * omega) / s;
    const kb = Math.sin(t * omega) / s;
    pts.push(toLngLat([va[0] * ka + vb[0] * kb, va[1] * ka + vb[1] * kb, va[2] * ka + vb[2] * kb]));
  }
  return pts;
}

const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

// Position `idx` (fractional index) along a polyline.
export function along(coords: LngLat[], idx: number): LngLat {
  const i = Math.max(0, Math.min(coords.length - 2, Math.floor(idx)));
  return lerp(coords[i], coords[i + 1], idx - i);
}

type Arc = { coords: LngLat[]; start: number; travel: number; greeted: boolean };

const ARC_POINTS = 72;
const ARC_FADE_IN_MS = 300;
const ARC_LINGER_MS = 1300;
const RIPPLE_MS = 1200;
const GREETING_MS = 2400;
const FRAME_MS = 33; // ~30 fps is plenty for this and spares the GeoJSON worker
const VISIBLE_DEG = 65; // only animate on the side of the globe facing us

let instance = 0;

/**
 * Starts the ambient layer on a loaded map. Returns a stop function; with
 * `fade`, the layer fades out before it's removed.
 */
export function startAmbient(
  map: MapboxMap,
  mapboxgl: MapboxGL,
  { motion, maxArcs }: { motion: boolean; maxArcs: number },
): (fade?: boolean) => void {
  const p = `pulse-ambient-${++instance}`;
  const ids = {
    glow: `${p}-glow`,
    lights: `${p}-lights`,
    arcs: `${p}-arcs`,
    trails: `${p}-trails`,
    heads: `${p}-heads`,
    ripples: `${p}-ripples`,
  };
  const lights = buildLights();
  const rand = mulberry32(Date.now() & 0xffffffff);
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

  map.addSource(ids.lights, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: lights.map((c, i) => ({
        type: "Feature",
        properties: { g: i % 3 },
        geometry: { type: "Point", coordinates: c },
      })),
    },
  });
  // Soft warm halo first, so clusters of lights read as glowing regions.
  map.addLayer({
    id: ids.glow,
    type: "circle",
    source: ids.lights,
    paint: {
      "circle-color": "#ff9e7a",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 4.5, 3, 8, 5, 12],
      "circle-blur": 1,
      "circle-opacity": 0.12,
      "circle-opacity-transition": { duration: 400 },
    },
  });
  map.addLayer({
    id: ids.lights,
    type: "circle",
    source: ids.lights,
    paint: {
      "circle-color": "#ffdcb4",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.6, 3, 2.5, 5, 3.4],
      "circle-blur": 0.3,
      "circle-opacity": 0.7,
      "circle-opacity-transition": { duration: 400 },
    },
  });

  const markers = new Set<Marker>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let raf = 0;

  if (motion) {
    for (const id of [ids.arcs, ids.heads, ids.ripples]) {
      map.addSource(id, { type: "geojson", data: empty });
    }
    // lineMetrics enables a per-trail gradient along `line-progress`.
    map.addSource(ids.trails, { type: "geojson", data: empty, lineMetrics: true });

    map.addLayer({
      id: ids.arcs,
      type: "line",
      source: ids.arcs,
      paint: {
        "line-color": "#ff9e8a",
        "line-width": 1,
        "line-dasharray": [1.5, 2],
        "line-opacity": ["*", 0.4, ["get", "o"]],
      },
    });
    map.addLayer({
      id: ids.trails,
      type: "line",
      source: ids.trails,
      layout: { "line-cap": "round" },
      paint: {
        "line-width": 2.5,
        "line-blur": 0.6,
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
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffb36b",
        "circle-stroke-opacity": ["get", "o"],
      },
    });
    map.addLayer({
      id: ids.heads,
      type: "circle",
      source: ids.heads,
      paint: {
        "circle-radius": 3,
        "circle-color": "#fff4e6",
        "circle-blur": 0.2,
        "circle-opacity": ["get", "o"],
        "circle-stroke-width": 6,
        "circle-stroke-color": "#ff8a7a",
        "circle-stroke-opacity": ["*", 0.25, ["get", "o"]],
      },
    });

    const arcs: Arc[] = [];
    let nextSpawn = performance.now() + 500;
    let lastFrame = 0;
    let lastTwinkle = 0;

    const spawn = (now: number) => {
      const c = map.getCenter();
      const center: LngLat = [c.lng, c.lat];
      const pool = lights.filter((pt) => angleDeg(pt, center) < VISIBLE_DEG);
      if (pool.length < 2) return;
      for (let tries = 0; tries < 16; tries++) {
        const a = pool[Math.floor(rand() * pool.length)];
        const b = pool[Math.floor(rand() * pool.length)];
        const km = angleDeg(a, b) * KM_PER_DEG;
        // Not next door, not halfway round the planet, never across the
        // antimeridian (the line would wrap the long way round).
        if (km < 700 || km > 6500 || Math.abs(a[0] - b[0]) > 180) continue;
        arcs.push({
          coords: greatCircle(a, b, ARC_POINTS),
          start: now,
          travel: 1300 + km * 0.2,
          greeted: false,
        });
        return;
      }
    };

    const greet = (at: LngLat) => {
      if (markers.size >= maxArcs) return;
      // Don't stack bubbles on top of each other.
      const here = map.project(at);
      for (const m of markers) {
        const there = map.project(m.getLngLat());
        if (Math.hypot(here.x - there.x, here.y - there.y) < 70) return;
      }
      const root = document.createElement("div");
      const bubble = document.createElement("span");
      bubble.className = "pulse-greet";
      bubble.textContent = GREETINGS[Math.floor(rand() * GREETINGS.length)];
      root.appendChild(bubble);
      const m = new mapboxgl.Marker({
        element: root,
        anchor: "bottom",
        offset: [0, -8],
        occludedOpacity: 0,
      })
        .setLngLat(at)
        .addTo(map);
      markers.add(m);
      const t = setTimeout(() => {
        m.remove();
        markers.delete(m);
        timers.delete(t);
      }, GREETING_MS);
      timers.add(t);
    };

    const feature = (
      geometry: GeoJSON.Geometry,
      properties: Record<string, number>,
    ): GeoJSON.Feature => ({ type: "Feature", properties, geometry });

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - lastFrame < FRAME_MS) return;
      lastFrame = now;

      if (now - lastTwinkle > 120) {
        lastTwinkle = now;
        const o = (g: number) => 0.55 + 0.35 * Math.sin(now / 900 + g * 2.1);
        map.setPaintProperty(ids.lights, "circle-opacity", [
          "match",
          ["get", "g"],
          0,
          o(0),
          1,
          o(1),
          o(2),
        ]);
      }

      if (now >= nextSpawn && arcs.length < maxArcs) {
        spawn(now);
        nextSpawn = now + 650 + rand() * 900;
      }

      const arcF: GeoJSON.Feature[] = [];
      const trailF: GeoJSON.Feature[] = [];
      const headF: GeoJSON.Feature[] = [];
      const rippleF: GeoJSON.Feature[] = [];
      for (let i = arcs.length - 1; i >= 0; i--) {
        const arc = arcs[i];
        const n = arc.coords.length;
        const elapsed = now - arc.start;
        const after = Math.max(0, elapsed - arc.travel);
        if (after > ARC_LINGER_MS) {
          arcs.splice(i, 1);
          continue;
        }
        const appear = Math.min(1, elapsed / ARC_FADE_IN_MS);
        const fade = 1 - Math.min(1, after / (ARC_LINGER_MS - 300));
        arcF.push(feature({ type: "LineString", coordinates: arc.coords }, { o: appear * fade }));

        const end = arc.coords[n - 1];
        if (after === 0) {
          const idx = (elapsed / arc.travel) * (n - 1);
          const tail = Math.max(0, idx - (n - 1) * 0.22);
          const pts: LngLat[] = [along(arc.coords, tail)];
          for (let k = Math.ceil(tail); k < idx; k++) pts.push(arc.coords[k]);
          pts.push(along(arc.coords, idx));
          if (pts.length >= 2) trailF.push(feature({ type: "LineString", coordinates: pts }, {}));
          headF.push(feature({ type: "Point", coordinates: pts[pts.length - 1] }, { o: 1 }));
        } else {
          if (!arc.greeted) {
            arc.greeted = true;
            greet(end);
          }
          const age = after / RIPPLE_MS;
          if (age < 1) {
            rippleF.push(feature({ type: "Point", coordinates: end }, { r: 3 + 22 * age, o: 0.85 * (1 - age) }));
          }
          headF.push(feature({ type: "Point", coordinates: end }, { o: Math.max(0, 1 - after / 500) }));
        }
      }

      const set = (id: string, features: GeoJSON.Feature[]) =>
        (map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
      set(ids.arcs, arcF);
      set(ids.trails, trailF);
      set(ids.heads, headF);
      set(ids.ripples, rippleF);
    };
    raf = requestAnimationFrame(frame);
  }

  const remove = () => {
    try {
      for (const id of [ids.heads, ids.ripples, ids.trails, ids.arcs, ids.glow, ids.lights]) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      }
    } catch {
      // The map itself may already be gone (unmount).
    }
  };

  return (fade = false) => {
    cancelAnimationFrame(raf);
    timers.forEach(clearTimeout);
    timers.clear();
    markers.forEach((m) => m.remove());
    markers.clear();
    if (!fade) return remove();
    try {
      map.setPaintProperty(ids.lights, "circle-opacity", 0);
      map.setPaintProperty(ids.glow, "circle-opacity", 0);
      for (const id of [ids.arcs, ids.trails]) {
        if (map.getLayer(id)) map.setPaintProperty(id, "line-opacity", 0);
      }
      for (const id of [ids.heads, ids.ripples]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
    } catch {
      return remove();
    }
    setTimeout(remove, 500);
  };
}
