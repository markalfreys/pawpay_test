"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import { LocateFixed, Users } from "lucide-react";
import type { PeerDot, WaveDir } from "@/lib/types";
import { beatDelayFor, colorFor } from "@/lib/palette";
import { startAmbient } from "@/lib/ambient";
import { distanceKm } from "@/lib/geo";
import { createWaveLayer, type WaveLayer } from "@/lib/waves";

// "me" or a peer id.
export type WorldMapHandle = {
  launchWave: (from: string, to: string) => void;
};

// No fallback: a placeholder token made `!TOKEN` always false, so a missing
// env var produced a blank map with no hint instead of the setup message below.
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Auto-framing never zooms in past neighbourhood level (~37 px per km): dots
// a few km apart stay clearly separate without filling the screen and losing
// geographic context. Dots are already offset 1–3 km, so this reveals nothing.
const MAX_AUTO_ZOOM = 12.5;
// Nobody nearby: centre the globe on the user at this zoom, so their
// hemisphere (and any distant dots on it) is in view.
const ARRIVAL_ZOOM = 2.6;
// Framing targets your nearest cluster, not everyone. On a globe you can't
// fit people on opposite sides of the planet on one screen (a box from New
// York to Sydney centres on Africa and shows nobody), and one person 2,000 km
// away shouldn't zoom you out so far that your neighbours in the same city
// overlap. So: include peers up to CLUSTER_FACTOR × your nearest neighbour's
// distance (at least MIN_CLUSTER_KM, never beyond NEARBY_KM).
const NEARBY_KM = 3000;
const MIN_CLUSTER_KM = 25;
const CLUSTER_FACTOR = 4;
const MAX_FRAMED = 25;
// Gate globe rotation speed.
const SPIN_DEG_PER_SEC = 3;
const LEAVE_ANIMATION_MS = 450;

export type MapMode = "gate" | "live";

type LngLat = { lat: number; lng: number };

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Face the visitor's own side of the planet on the gate: their UTC offset
// is a free, permission-less longitude hint (UTC+8 → ~120°E).
function homeLongitude(): number {
  return (-new Date().getTimezoneOffset() / 60) * 15;
}

const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };

// Whole-globe zoom, plus camera padding that places the globe beside
// (desktop) or above (mobile) the gate's copy. Padding (rather than moving
// the container) keeps the Mapbox logo + attribution in their corners where
// they stay visible. Padding persists and would offset every later
// fitBounds(), so it's animated back to zero before the fly-in.
// Desktop gate layout: copy on the left margin, globe on the right margin,
// the globe growing to fill what's between. Mirrors `.gate-copy` in
// globals.css and the copy widths in EntryGate (md:w-[30rem] 2xl:w-[36rem])
// — keep them in sync.
const GATE_MARGIN_VW = 0.08;
const GATE_MIN_MARGIN_REM = 4;
const GATE_COPY_REM = 30;
const GATE_COPY_2XL_REM = 36;
const GATE_GAP_REM = 2;

function gateCamera(el: HTMLElement) {
  const w = el.clientWidth;
  const h = el.clientHeight;
  // Globe diameter ≈ world size / π (world size = 512 · 2^zoom); measured
  // on screen it renders ~6% larger (camera perspective), so compensate.
  const zoomFor = (diameter: number) => Math.log2((diameter * Math.PI) / 512 / 1.06);

  if (w < 768) {
    // Phones: globe in the top half, copy below.
    const diameter = Math.min(w * 0.92, h * 0.46);
    return { zoom: zoomFor(diameter), padding: { ...NO_PADDING, bottom: Math.round(h * 0.5) } };
  }

  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const margin = Math.max(GATE_MIN_MARGIN_REM * rem, w * GATE_MARGIN_VW);
  const copy = (w >= 1536 ? GATE_COPY_2XL_REM : GATE_COPY_REM) * rem;
  const gap = GATE_GAP_REM * rem;
  // Fill the space between the copy and the right margin, up to 92% of the
  // height. On narrow screens it keeps a minimum size and slides under the
  // copy (the scrim keeps the text readable).
  const diameter = Math.min(h * 0.92, Math.max(w * 0.4, w - 2 * margin - copy - gap));
  const centerX = w - margin - diameter / 2;
  // Padding moves the map's centre point to (w + left − right) / 2.
  const shift = Math.round(2 * centerX - w);
  return {
    zoom: zoomFor(diameter),
    padding: shift >= 0 ? { ...NO_PADDING, left: shift } : { ...NO_PADDING, right: -shift },
  };
}

const hasPadding = (p: { top?: number; bottom?: number; left?: number; right?: number }) =>
  (p.top ?? 0) + (p.bottom ?? 0) + (p.left ?? 0) + (p.right ?? 0) > 0;

function setInteractive(map: MapboxMap, on: boolean) {
  for (const h of [
    map.scrollZoom,
    map.boxZoom,
    map.dragPan,
    map.keyboard,
    map.doubleClickZoom,
    map.touchZoomRotate,
  ]) {
    if (on) h.enable();
    else h.disable();
  }
  // Keep the globe north-up: rotation/pitch only confuse a "tap a dot" UI.
  map.dragRotate.disable();
  map.touchPitch.disable();
  map.touchZoomRotate.disableRotation();
}

// Signed longitude difference folded into [-180, 180).
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

// Move the camera so the user and their nearest cluster are on screen.
// Returns false when nobody is nearby (nothing to frame).
function frameEveryone(map: MapboxMap, me: LngLat | null, peers: PeerDot[]): boolean {
  if (!me) return false;
  const byDistance = peers
    .map((p) => ({ p, km: distanceKm(me, p) }))
    .sort((a, b) => a.km - b.km);
  const nearest = byDistance[0];
  if (!nearest || nearest.km > NEARBY_KM) return false;
  const radius = Math.min(NEARBY_KM, Math.max(MIN_CLUSTER_KM, nearest.km * CLUSTER_FACTOR));
  const near = byDistance.filter((x) => x.km <= radius).slice(0, MAX_FRAMED);

  // Unwrap longitudes around the user so a neighbour across the antimeridian
  // (Fiji ↔ Samoa) doesn't produce a 358°-wide box.
  const points: [number, number][] = [
    [me.lng, me.lat],
    ...near.map(({ p }): [number, number] => [me.lng + wrap180(p.lng - me.lng), p.lat]),
  ];

  let [minLng, minLat] = points[0];
  let [maxLng, maxLat] = points[0];
  for (const [lng, lat] of points) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  // Keep padding proportional so it can't exceed the viewport on phones.
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const padding = Math.round(Math.min(110, w / 5, h / 5));
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding, maxZoom: MAX_AUTO_ZOOM, duration: 1800 },
  );
  return true;
}

const peerKey = (peers: PeerDot[]) =>
  peers
    .map((p) => p.id)
    .sort()
    .join(",");

function createDot(peer: PeerDot): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "pulse-marker";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pulse-dot";
  btn.dataset.peerId = peer.id;
  btn.style.setProperty("--c", colorFor(peer.id));
  btn.style.setProperty("--beat-delay", beatDelayFor(peer.id));
  btn.innerHTML =
    '<span class="pulse-ring"></span><span class="pulse-ring"></span>' +
    '<span class="pulse-core"></span><span class="pulse-tip"></span>';
  root.appendChild(btn);
  return root;
}

export default function WorldMap({
  mode,
  peers,
  me,
  highlightId,
  waves,
  onPeerClick,
  canConnect,
  chatOpen,
  ref,
}: {
  mode: MapMode;
  peers: PeerDot[];
  // The user's *public* (offset) position — where everyone else sees them.
  me: LngLat | null;
  // The person being called / calling / talking with.
  highlightId: string | null;
  // Waves in flight, by peer id: badges their dot.
  waves: Record<string, { dir: WaveDir }>;
  onPeerClick: (id: string) => void;
  canConnect: boolean;
  // On desktop the chat card covers the right edge; shift controls clear of it.
  chatOpen: boolean;
  ref?: Ref<WorldMapHandle>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const leavingRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const meMarkerRef = useRef<Marker | null>(null);
  const waveLayerRef = useRef<WaveLayer | null>(null);
  const [ready, setReady] = useState(false);

  // Marker click handlers are bound once, so read the live click handler +
  // connectability through refs (synced in an effect, never during render).
  const onPeerClickRef = useRef(onPeerClick);
  const canConnectRef = useRef(canConnect);
  const modeRef = useRef(mode);
  const busyRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    onPeerClickRef.current = onPeerClick;
    canConnectRef.current = canConnect;
    modeRef.current = mode;
  });

  // Auto-framing: keep everyone in view as people join/leave, until the user
  // moves the camera themselves — then never fight them. "Show everyone"
  // re-frames and hands control back to auto-framing.
  const userMovedRef = useRef(false);
  const framedKeyRef = useRef<string | null>(null);
  // Gestures only count once we've framed someone at least once — otherwise a
  // habitual scroll while the map loads (before any dot arrives) would switch
  // auto-framing off before it ever got a chance to help.
  const hasFramedRef = useRef(false);
  // The first live frame is the fly-in from the gate globe; re-framing waits
  // until it has started so the two camera moves don't fight.
  const arrivedRef = useRef(false);
  const settledRef = useRef(false);
  // Latest props for callbacks that fire after an animation finishes.
  const peersRef = useRef(peers);
  const meRef = useRef(me);
  useEffect(() => {
    peersRef.current = peers;
    meRef.current = me;
  });

  // Initialise the map once.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;
    const markers = markersRef.current;
    const leaving = leavingRef.current;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      const el = containerRef.current;
      if (cancelled || !el) return;
      mapboxgl.accessToken = TOKEN;
      const gate = gateCamera(el);
      const map = new mapboxgl.Map({
        container: el,
        style: "mapbox://styles/mapbox/dark-v11",
        projection: "globe",
        center: [homeLongitude(), 18],
        zoom: gate.zoom,
        attributionControl: false,
      });
      map.setPadding(gate.padding);
      // Compact attribution keeps the required credit without the clutter.
      map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
      setInteractive(map, false);

      map.on("style.load", () => {
        // Night-side atmosphere + stars, so the empty space around the globe
        // reads as space rather than a black void.
        map.setFog({
          color: "rgb(13, 15, 28)",
          "high-color": "rgb(38, 52, 120)",
          "horizon-blend": 0.05,
          "space-color": "rgb(5, 6, 11)",
          "star-intensity": 0.5,
        });
      });
      map.on("load", () => {
        if (!cancelled) setReady(true);
      });

      // Only gestures carry an originalEvent; our own camera calls don't.
      // (Mapbox's typings omit it on zoom events, but it's there at runtime.)
      const takeOver = (e: object) => {
        if (!hasFramedRef.current) return;
        if ("originalEvent" in e && e.originalEvent) userMovedRef.current = true;
      };
      map.on("dragstart", takeOver);
      map.on("zoomstart", takeOver);
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      leaving.forEach(clearTimeout);
      leaving.clear();
      markers.forEach((m) => m.remove());
      markers.clear();
      meMarkerRef.current?.remove();
      meMarkerRef.current = null;
      waveLayerRef.current?.destroy();
      waveLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // Send a wave flying between two dots ("me" or a peer id). Purely visual;
  // the page decides when. Skipped for reduced motion: the dot badge alone
  // tells the story.
  useImperativeHandle(
    ref,
    () => ({
      launchWave(from, to) {
        const map = mapRef.current;
        if (!map || modeRef.current !== "live" || prefersReducedMotion()) return;
        const at = (id: string): LngLat | null =>
          id === "me" ? meRef.current : (peersRef.current.find((p) => p.id === id) ?? null);
        const a = at(from);
        const b = at(to);
        if (!a || !b) return;
        try {
          waveLayerRef.current ??= createWaveLayer(map);
        } catch {
          return; // style not ready yet; the badge still shows
        }
        waveLayerRef.current.launch([a.lng, a.lat], [b.lng, b.lat], colorFor(from === "me" ? to : from));
      },
    }),
    [],
  );

  // Gate: slowly spin the globe. Live: hand the camera to the user.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (mode === "live") {
      setInteractive(map, true);
      return;
    }
    if (prefersReducedMotion()) return;
    let active = true;
    const spin = () => {
      if (!active) return;
      const c = map.getCenter();
      map.easeTo({
        center: [c.lng - SPIN_DEG_PER_SEC, c.lat],
        duration: 1000,
        easing: (t) => t,
      });
    };
    map.on("moveend", spin);
    spin();
    return () => {
      active = false;
      map.off("moveend", spin);
      map.stop();
    };
  }, [mode, ready]);

  // Gate: the illustrative "world is alive" layer (city lights + greetings
  // crossing the globe). Gate only — it fades out as you enter, so nothing
  // fake is ever on the live map or clickable.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || mode !== "gate") return;
    let cancelled = false;
    let stop: ((fade?: boolean) => void) | null = null;
    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      stop = startAmbient(map, mapboxgl, {
        motion: !prefersReducedMotion(),
        maxArcs: map.getContainer().clientWidth < 768 ? 3 : 6,
      });
    })();
    return () => {
      cancelled = true;
      stop?.(true);
    };
  }, [mode, ready]);

  // Gate: re-fit the globe when the window changes size (phone rotation,
  // resizing, DevTools device mode) — otherwise it keeps the size and offset
  // computed for the original window and can spill under the copy.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || mode !== "gate") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const el = containerRef.current;
        if (!el) return;
        const { zoom, padding } = gateCamera(el);
        // Interrupting the spin fires moveend, so the spin carries on.
        map.jumpTo({ zoom, padding });
      }, 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [mode, ready]);

  // Show / move the "You" marker at the user's public position.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !me) return;
    let cancelled = false;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      if (!meMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "pulse-me";
        el.title = "This is where others see you — 1–3 km from your real location";
        el.innerHTML =
          '<span class="pulse-me-halo"></span><span class="pulse-me-core"></span>' +
          '<span class="pulse-me-label">You</span>';
        meMarkerRef.current = new mapboxgl.Marker({ element: el })
          .setLngLat([me.lng, me.lat])
          .addTo(map);
      } else {
        meMarkerRef.current.setLngLat([me.lng, me.lat]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [me, ready]);

  // Reconcile markers whenever the peer list changes (or the map becomes ready).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      const markers = markersRef.current;
      const leaving = leavingRef.current;
      const seen = new Set<string>();
      const preview = mode === "gate";

      for (const peer of peers) {
        seen.add(peer.id);
        busyRef.current.set(peer.id, peer.busy);
        let marker = markers.get(peer.id);
        if (!marker) {
          const root = createDot(peer);
          const btn = root.firstElementChild as HTMLButtonElement;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (modeRef.current !== "live") return;
            // A busy peer would just be auto-declined by the server.
            if (busyRef.current.get(peer.id)) return;
            if (canConnectRef.current) onPeerClickRef.current(peer.id);
          });
          marker = new mapboxgl.Marker({ element: root })
            .setLngLat([peer.lng, peer.lat])
            .addTo(map);
          markers.set(peer.id, marker);
        } else {
          // Came back before its exit animation finished — keep it.
          const pending = leaving.get(peer.id);
          if (pending) {
            clearTimeout(pending);
            leaving.delete(peer.id);
            marker.getElement().firstElementChild?.classList.remove("is-leaving");
          }
          // A peer that re-joined gets a fresh offset — keep the dot in sync.
          marker.setLngLat([peer.lng, peer.lat]);
        }
        const btn = marker.getElement().firstElementChild as HTMLButtonElement;
        const wave = preview ? undefined : waves[peer.id]?.dir;
        const label = preview
          ? ""
          : peer.busy
            ? "In a conversation"
            : wave === "in"
              ? "Waved at you"
              : wave === "out"
                ? "You waved"
                : "Say hi";
        btn.dataset.busy = String(peer.busy);
        btn.dataset.wave = wave ?? "";
        btn.dataset.highlight = String(peer.id === highlightId);
        btn.dataset.preview = String(preview);
        btn.tabIndex = preview ? -1 : 0;
        btn.setAttribute("aria-label", label || "Someone online");
        (btn.querySelector(".pulse-tip") as HTMLElement).textContent = label;
      }

      // Peers that went offline: play the exit animation, then remove.
      for (const [id, marker] of markers) {
        if (seen.has(id) || leaving.has(id)) continue;
        marker.getElement().firstElementChild?.classList.add("is-leaving");
        leaving.set(
          id,
          setTimeout(() => {
            marker.remove();
            markers.delete(id);
            leaving.delete(id);
            busyRef.current.delete(id);
          }, LEAVE_ANIMATION_MS),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [peers, ready, mode, highlightId, waves]);

  // Live camera: fly in on arrival, then re-frame whenever the set of people
  // changes (joins/leaves, not every poll) unless the user took the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || mode !== "live" || !me) return;

    if (!arrivedRef.current) {
      arrivedRef.current = true;
      const arrive = () => {
        // Frame whoever is around *now* (the list may have changed while
        // the gate padding was gliding away).
        const current = peersRef.current;
        framedKeyRef.current = peerKey(current);
        if (frameEveryone(map, meRef.current, current)) {
          hasFramedRef.current = true;
        } else if (meRef.current) {
          const { lng, lat } = meRef.current;
          map.flyTo({ center: [lng, lat], zoom: ARRIVAL_ZOOM, duration: 2600, curve: 1.6 });
        }
        settledRef.current = true;
      };
      if (hasPadding(map.getPadding())) {
        // First glide the globe back to centre, then fly in.
        map.easeTo({ padding: NO_PADDING, duration: 900 });
        map.once("moveend", arrive);
      } else {
        arrive();
      }
      return;
    }

    if (!settledRef.current || userMovedRef.current) return;
    const key = peerKey(peers);
    if (key === framedKeyRef.current) return;
    framedKeyRef.current = key;
    if (frameEveryone(map, me, peers)) hasFramedRef.current = true;
  }, [peers, me, ready, mode]);

  // Frame the people near you (or, if nobody's near, your side of the globe)
  // and hand the camera back to auto-framing.
  function showEveryone() {
    const map = mapRef.current;
    if (!map || !me) return;
    userMovedRef.current = false;
    framedKeyRef.current = peerKey(peers);
    if (frameEveryone(map, me, peers)) hasFramedRef.current = true;
    else map.flyTo({ center: [me.lng, me.lat], zoom: ARRIVAL_ZOOM, duration: 1600 });
  }

  function findMe() {
    const map = mapRef.current;
    if (!map || !me) return;
    // An explicit camera choice: don't yank it away on the next join.
    userMovedRef.current = true;
    map.flyTo({ center: [me.lng, me.lat], zoom: Math.max(map.getZoom(), 10), duration: 1400 });
  }

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full bg-bg" />

      {!TOKEN && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-6 text-center">
          <p className="glass max-w-md rounded-2xl p-5 text-sm text-ink">
            Set <code className="font-mono text-accent-2">NEXT_PUBLIC_MAPBOX_TOKEN</code> in{" "}
            <code className="font-mono">.env</code> to load the globe.
          </p>
        </div>
      )}

      {mode === "live" && (
        <div
          className={`animate-fade absolute right-4 top-[calc(1rem+var(--safe-top))] z-10 flex flex-col gap-2 transition-[right] duration-500 md:top-6 ${
            chatOpen ? "md:right-[26rem]" : "md:right-6"
          }`}
        >
          <button
            type="button"
            onClick={showEveryone}
            aria-label="Show people near you"
            title="Show people near you"
            className="glass icon-btn h-11 w-11 hover:text-accent-2"
          >
            <Users className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={findMe}
            aria-label="Find me"
            title="Find me"
            className="glass icon-btn h-11 w-11 hover:text-accent-2"
          >
            <LocateFixed className="h-[18px] w-[18px]" />
          </button>
        </div>
      )}
    </div>
  );
}
