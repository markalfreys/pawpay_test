// API security checks: each one replays an attack that worked against the old
// API (or a guarantee the fixes added) against a running Pulse instance.
// Plain fetch, no browser.
//
//   npm run dev                          # in another terminal
//   npm run test:security                # defaults to http://localhost:3000
//   npm run test:security -- https://your-app.vercel.app
//
// The test users sit in the South Atlantic and leave when it finishes.
import { randomUUID } from "node:crypto";

const BASE = process.argv[2] ?? "http://localhost:3000";
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
  } catch (e) {
    record(name, false, String(e?.message ?? e).split("\n")[0]);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function api(path, { key, method = "GET", body } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const users = [];

async function joinAs(name, lat, lng) {
  const key = randomUUID();
  const r = await api("/api/join", { key, method: "POST", body: { lat, lng } });
  expect(r.status === 200, `${name} join → ${r.status}`);
  const u = { name, key, id: r.data.id, lat: r.data.lat, lng: r.data.lng, real: { lat, lng }, inbox: [] };
  users.push(u);
  return u;
}

const signal = (from, toId, type, payload, extra = {}) =>
  api("/api/signal", { key: from.key, method: "POST", body: { toId, type, payload, ...extra } });

// Polling drains the mailbox, so keep what arrives, like the real client.
async function poll(u) {
  const r = await api("/api/poll", { key: u.key });
  expect(r.status === 200, `${u.name} poll → ${r.status}`);
  u.inbox.push(...r.data.signals);
  return r.data;
}

// Users who stop polling are reaped after 15 s, so heartbeat everyone.
const heartbeat = setInterval(() => {
  for (const u of users) poll(u).catch(() => {});
}, 3_000);

async function seen(viewer, u) {
  const dot = (await poll(viewer)).peers.find((p) => p.id === u.id);
  expect(dot, `${u.name} is not on the map`);
  return dot;
}

function km(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const status = (r, want) => expect(r.status === want, `got ${r.status} ${JSON.stringify(r.data)}, want ${want}`);

try {
  const A = await joinAs("A", -40.0, -20.0);
  const B = await joinAs("B", -40.5, -21.0);
  const M = await joinAs("M (attacker)", -41.0, -22.0);
  const V = await joinAs("V (viewer)", -41.5, -23.0);

  // --- Identity: the public id on every dot is not a credential ----------
  await check("poll without a key is refused", async () => {
    status(await api("/api/poll"), 401);
  });
  await check("poll with someone's public id (old ?id= style) is refused", async () => {
    status(await api(`/api/poll?id=${A.id}`), 401);
    status(await api("/api/poll", { key: A.id }), 401);
  });
  await check("join with someone's public id can't move their dot", async () => {
    status(await api("/api/join", { key: A.id, method: "POST", body: { lat: 0, lng: 0 } }), 401);
    status(await api("/api/join", { method: "POST", body: { id: A.id, lat: 0, lng: 0 } }), 401);
    const a = await seen(V, A);
    expect(a && a.lat === A.lat && a.lng === A.lng, "A's dot moved");
  });
  await check("leave with someone's public id can't kick them", async () => {
    status(await api("/api/leave", { method: "POST", body: { id: A.id } }), 401);
    status(await api("/api/leave", { method: "POST", body: { key: A.id } }), 401);
    expect(await seen(V, A), "A was removed from the map");
  });

  // --- Signals must fit the link between the two people -------------------
  await check("forged accept can't mark a stranger busy", async () => {
    status(await signal(M, A.id, "accept"), 409);
    expect((await seen(V, A))?.busy === false, "A was marked busy");
  });
  await check("SDP can't be pushed at someone who never accepted", async () => {
    status(await signal(M, A.id, "offer", JSON.stringify({ type: "offer", sdp: "v=0" })), 409);
    status(await signal(M, A.id, "ice", JSON.stringify({ candidate: "" })), 409);
  });

  // M rings B first, then A and B connect. M is still "pending" on B.
  await check("real handshake: A requests B, B accepts", async () => {
    status(await signal(M, B.id, "request"), 200);
    status(await signal(A, B.id, "request"), 200);
    await poll(B);
    const fromA = B.inbox.find((s) => s.type === "request" && s.fromId === A.id);
    expect(fromA, "B never received A's request (or fromId isn't A's public id)");
    status(await signal(B, A.id, "accept"), 200);
    const [a, b] = [await seen(V, A), await seen(V, B)];
    expect(a?.busy && b?.busy, "A and B should both be busy");
  });
  await check("a fromId in the body is ignored (can't send as someone else)", async () => {
    status(await signal(M, A.id, "end", undefined, { fromId: B.id }), 409);
    expect((await seen(V, A))?.busy, "A was freed by a forged end");
  });
  await check("a requester giving up doesn't free someone mid-chat", async () => {
    // M's request to B is still pending, so M may end it, but B is with A.
    status(await signal(M, B.id, "end"), 200);
    expect((await seen(V, B))?.busy, "B was freed by M's end");
  });
  await check("nobody can wave at someone in a conversation", async () => {
    status(await signal(M, A.id, "wave"), 409);
  });
  await check("someone in a conversation can't wave at others", async () => {
    status(await signal(A, M.id, "wave"), 409);
  });

  // --- Payloads -----------------------------------------------------------
  await check("malformed payloads are rejected", async () => {
    status(await signal(A, B.id, "ice", "not json"), 400);
    status(await signal(A, B.id, "offer", JSON.stringify({ type: "answer", sdp: "v=0" })), 400);
    status(await signal(A, B.id, "offer", "x".repeat(17 * 1024)), 400);
    status(await signal(A, B.id, "end", "unexpected"), 400);
    status(await signal(A, B.id, "wave", "a wave carries no text"), 400);
    status(await signal(A, B.id, "unwave", "neither does an unwave"), 400);
  });
  await check("relayed payloads carry only the expected fields", async () => {
    const ice = { candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0, extra: "<img onerror=alert(1)>" };
    status(await signal(A, B.id, "ice", JSON.stringify(ice)), 200);
    await poll(B);
    const got = B.inbox.find((s) => s.type === "ice" && s.fromId === A.id);
    expect(got, "ICE not delivered");
    expect(!("extra" in JSON.parse(got.payload)), "extra field was relayed");
  });

  await check("ending the chat frees both sides", async () => {
    status(await signal(A, B.id, "end"), 200);
    const [a, b] = [await seen(V, A), await seen(V, B)];
    expect(a?.busy === false && b?.busy === false, "still busy");
  });

  // --- Location privacy ---------------------------------------------------
  await check("dot is 1–3 km away and stays put across re-joins", async () => {
    const d = km(A.real, A);
    expect(d >= 0.99 && d <= 3.01, `offset ${d.toFixed(2)} km`);
    for (let i = 0; i < 3; i++) {
      const r = await api("/api/join", { key: A.key, method: "POST", body: A.real });
      expect(r.data.lat === A.lat && r.data.lng === A.lng, "re-join produced a new offset");
    }
    return `${d.toFixed(2)} km`;
  });

  // --- Rate limiting ------------------------------------------------------
  await check("one person can't be flooded with waves", async () => {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await signal(M, V.id, "wave")).status);
    expect(codes[0] === 200 && codes[1] === 200 && codes[2] === 429, `statuses ${codes}`);
  });
  await check("one person can't be flooded with connection requests", async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await signal(M, V.id, "request")).status);
    expect(codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429, `statuses ${codes}`);
  });
} catch (e) {
  record("setup", false, String(e?.message ?? e));
} finally {
  clearInterval(heartbeat);
  for (const u of users) await api("/api/leave", { method: "POST", body: { key: u.key } }).catch(() => {});
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
