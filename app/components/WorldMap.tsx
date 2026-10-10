"use client";

import { useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import type { PeerDot } from "@/lib/types";

// No fallback: a placeholder token made `!TOKEN` always false, so a missing
// env var produced a blank map with no hint instead of the setup message below.
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Auto-framing never zooms in past neighbourhood level (~37 px per km): dots
// a few km apart stay clearly separate without filling the screen and losing
// geographic context. Dots are already offset 1–3 km, so this reveals nothing.
const MAX_AUTO_ZOOM = 12.5;

function dotColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360}, 70%, 60%)`;
}

// Move the camera so the user and every peer are on screen. No-op (returns
// false) when the user is alone — nothing to frame, keep the regional view.
function frameEveryone(
  map: MapboxMap,
  me: { lat: number; lng: number } | null,
  peers: PeerDot[],
): boolean {
  const points: [number, number][] = peers.map((p) => [p.lng, p.lat]);
  if (me) points.push([me.lng, me.lat]);
  if (points.length < 2) return false;

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
  const padding = Math.round(Math.min(96, w / 6, h / 6));
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding, maxZoom: MAX_AUTO_ZOOM, duration: 1200 },
  );
  return true;
}

const peerKey = (peers: PeerDot[]) =>
  peers
    .map((p) => p.id)
    .sort()
    .join(",");

export default function WorldMap({
  peers,
  me,
  onPeerClick,
  canConnect,
}: {
  peers: PeerDot[];
  me: { lat: number; lng: number } | null;
  onPeerClick: (id: string) => void;
  canConnect: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const meMarkerRef = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);

  // Marker click handlers are bound once, so read the live click handler +
  // connectability through refs (synced in an effect, never during render).
  const onPeerClickRef = useRef(onPeerClick);
  const canConnectRef = useRef(canConnect);
  const busyRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    onPeerClickRef.current = onPeerClick;
    canConnectRef.current = canConnect;
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

  // Initialise the map once.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;
    const markers = markersRef.current;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled || !containerRef.current) return;
      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/dark-v11",
        // Open centered on the user if we know where they are, else world view.
        center: me ? [me.lng, me.lat] : [0, 20],
        zoom: me ? 4 : 1.4,
        attributionControl: true,
      });
      map.on("load", () => {
        if (!cancelled) setReady(true);
      });
      // Only gestures carry an originalEvent; our own fitBounds() calls don't.
      // (Mapbox's typings omit it on zoom/pitch events, but it's there at runtime.)
      const takeOver = (e: object) => {
        if (!hasFramedRef.current) return;
        if ("originalEvent" in e && e.originalEvent) userMovedRef.current = true;
      };
      map.on("dragstart", takeOver);
      map.on("zoomstart", takeOver);
      map.on("rotatestart", takeOver);
      map.on("pitchstart", takeOver);
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      markers.forEach((m) => m.remove());
      markers.clear();
      meMarkerRef.current?.remove();
      meMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // `me` is only read for the initial center; we don't want to re-init on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show / move the user's own "you are here" pin.
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
        el.title = "You are here";
        el.innerHTML = `<span class="pulse-me-label">Me</span>📍`;
        // anchor "bottom" → the pin's tip sits on the exact coordinate.
        meMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: "bottom" })
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
      const seen = new Set<string>();

      for (const peer of peers) {
        seen.add(peer.id);
        busyRef.current.set(peer.id, peer.busy);
        let marker = markers.get(peer.id);
        if (!marker) {
          const el = document.createElement("button");
          el.className = "pulse-dot";
          el.dataset.peerId = peer.id;
          el.style.background = dotColor(peer.id);
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            // A busy peer would just be auto-declined by the server.
            if (busyRef.current.get(peer.id)) return;
            if (canConnectRef.current) onPeerClickRef.current(peer.id);
          });
          marker = new mapboxgl.Marker({ element: el })
            .setLngLat([peer.lng, peer.lat])
            .addTo(map);
          markers.set(peer.id, marker);
        } else {
          // A peer that re-joined gets a fresh offset — keep the dot in sync.
          marker.setLngLat([peer.lng, peer.lat]);
        }
        const el = marker.getElement();
        el.dataset.busy = String(peer.busy);
        el.title = peer.busy ? "In a conversation" : "Tap to connect";
        el.style.opacity = peer.busy ? "0.35" : "1";
        el.style.cursor = peer.busy ? "not-allowed" : "pointer";
      }

      // Drop markers for peers that went offline / got filtered out.
      for (const [id, marker] of markers) {
        if (!seen.has(id)) {
          marker.remove();
          markers.delete(id);
          busyRef.current.delete(id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [peers, ready]);

  // Re-frame whenever the set of people changes (not on every poll — only
  // joins/leaves), unless the user has taken over the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || userMovedRef.current) return;
    const key = peerKey(peers);
    if (key === framedKeyRef.current) return;
    framedKeyRef.current = key;
    if (frameEveryone(map, me, peers)) hasFramedRef.current = true;
  }, [peers, me, ready]);

  function showEveryone() {
    const map = mapRef.current;
    if (!map) return;
    userMovedRef.current = false;
    framedKeyRef.current = peerKey(peers);
    if (frameEveryone(map, me, peers)) hasFramedRef.current = true;
  }

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full bg-zinc-900" />

      {!TOKEN && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="max-w-md rounded-lg bg-zinc-800 p-4 text-sm text-zinc-200">
            Set{" "}
            <code className="text-emerald-400">NEXT_PUBLIC_MAPBOX_TOKEN</code> in{" "}
            <code>.env</code> to load the map.
          </p>
        </div>
      )}

      {/* Online count + re-frame. Top-left: bottom-left is the Mapbox logo
          (which must stay visible) and, in dev, the Next.js indicator. */}
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <div className="rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur">
          {peers.length} online
        </div>
        {peers.length > 0 && (
          <button
            onClick={showEveryone}
            className="rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur hover:bg-zinc-800 hover:text-zinc-100"
          >
            Show everyone
          </button>
        )}
      </div>
    </div>
  );
}
