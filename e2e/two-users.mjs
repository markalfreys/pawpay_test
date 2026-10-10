// End-to-end smoke test: two (and a third, crashing) anonymous users against a
// running Pulse instance. Drives your installed Chrome via playwright-core with
// fake camera/mic and mocked geolocation.
//
//   npm run dev                      # in another terminal
//   npm run test:e2e                 # defaults to http://localhost:3000
//   npm run test:e2e -- https://your-app.vercel.app
//
// Set CHROME_PATH to use a specific Chrome/Chromium binary.
//
// Run it against a quiet database:
// - other people online nearby change what the map frames (it frames your
//   nearest cluster), so the auto-framing check assumes A and B are alone;
// - an *old* build of the app on the same DB keeps every dot alive (the
//   original heartbeat bug refreshed every row), so the crash check fails.
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://localhost:3000";
const results = [];
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} [${ts()}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
    return true;
  } catch (e) {
    record(name, false, String(e?.message ?? e).split("\n")[0]);
    return false;
  }
}

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: "chrome" }),
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

async function user(name, latitude, longitude) {
  const ctx = await browser.newContext({
    geolocation: { latitude, longitude },
    permissions: ["geolocation", "camera", "microphone"],
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  const u = { name, ctx, page, id: null };
  // Learn this user's public session id from the join call.
  page.on("response", async (r) => {
    if (!r.url().includes("/api/join")) return;
    try {
      const sent = JSON.parse(r.request().postData() ?? "{}");
      if (sent.id) u.id = sent.id;
      const got = await r.json().catch(() => ({}));
      if (got.id) u.id = got.id;
    } catch {}
  });
  return u;
}

async function enter(u) {
  await u.page.goto(BASE, { waitUntil: "load" });
  const live = u.page.locator('main[data-phase="live"]');
  // Retry in case the first click lands before hydration attaches the handler.
  for (let i = 0; i < 5 && !(await live.count()); i++) {
    await u.page
      .getByRole("button", { name: /enter pulse/i })
      .first()
      .click({ timeout: 3_000 })
      .catch(() => {});
    await live.waitFor({ timeout: 4_000 }).catch(() => {});
  }
  if (!(await live.count())) throw new Error("never left the entry screen");
  await u.page.waitForSelector(".mapboxgl-canvas", { timeout: 20_000 });
  for (let i = 0; i < 50 && !u.id; i++) await u.page.waitForTimeout(100);
  if (!u.id) throw new Error("no session id observed");
  return `id=${u.id.slice(0, 8)}…`;
}

const marker = (viewer, peerId) => viewer.page.locator(`[data-peer-id="${peerId}"]`);

async function waitForMarker(viewer, peerId, present = true, timeout = 12_000) {
  await marker(viewer, peerId).waitFor({ state: present ? "attached" : "detached", timeout });
}

// "Framed" = the peer's dot is on screen AND well separated from the viewer's
// own pin. On-screen alone isn't enough: Manila is already visible from Davao
// at the initial zoom, so that check passed even when no framing happened.
async function waitFramed(viewer, peerId, timeout = 8_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await marker(viewer, peerId)
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const me = document.querySelector(".pulse-me")?.getBoundingClientRect();
        const onScreen = r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        const gap = me ? Math.hypot(me.x - r.x, me.y - r.y) : 0;
        return { onScreen, gap: Math.round(gap), want: Math.round(Math.min(innerWidth, innerHeight) / 4) };
      })
      .catch(() => null);
    if (last?.onScreen && last.gap >= last.want) return;
    await viewer.page.waitForTimeout(300);
  }
  throw new Error(`not framed: ${JSON.stringify(last)}`);
}

async function waitBusy(viewer, peerId, want, timeout = 8_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await marker(viewer, peerId).getAttribute("data-busy").catch(() => null);
    if (last === String(want)) return;
    await viewer.page.waitForTimeout(300);
  }
  throw new Error(`data-busy=${last}, expected ${want}`);
}

const text = (u, re, timeout = 15_000) =>
  u.page.getByText(re).first().waitFor({ state: "visible", timeout });

const chatInput = (u) => u.page.getByPlaceholder(/message/i).first();

async function connect(a, b) {
  await waitForMarker(a, b.id);
  // Dispatch directly: the dot may be off-screen at the current zoom.
  await marker(a, b.id).dispatchEvent("click");
  await text(b, /wants to connect/i);
  await b.page.getByRole("button", { name: /^accept$/i }).first().click();
  await Promise.all([chatInput(a).waitFor({ timeout: 20_000 }), chatInput(b).waitFor({ timeout: 20_000 })]);
  await Promise.all([
    a.page.waitForFunction(() => !document.querySelector("input[disabled]"), null, { timeout: 20_000 }),
    b.page.waitForFunction(() => !document.querySelector("input[disabled]"), null, { timeout: 20_000 }),
  ]);
}

async function send(u, msg) {
  await chatInput(u).fill(msg);
  await chatInput(u).press("Enter");
}

const remoteVideoPlaying = (u) =>
  u.page.waitForFunction(
    () => [...document.querySelectorAll("video")].some((v) => !v.muted && v.videoWidth > 0 && !v.paused),
    null,
    { timeout: 20_000 },
  );

const A = await user("A", 7.07, 125.61); // Davao
const B = await user("B", 14.6, 120.98); // Manila

try {
  await step("A enters", () => enter(A));
  await step("B enters", () => enter(B));
  await step("A sees B's dot", () => waitForMarker(A, B.id));
  await step("B sees A's dot", () => waitForMarker(B, A.id));
  // A entered first (alone, regional zoom around Davao); when B joins from
  // Manila, A's camera should re-frame so both dots are on screen.
  await step("maps auto-frame so everyone is on screen", async () => {
    await waitFramed(A, B.id);
    await waitFramed(B, A.id);
  });

  if (await step("A taps B, B accepts → chat opens on both", () => connect(A, B))) {
    await step("both dots marked busy while chatting", async () => {
      await waitBusy(A, B.id, true);
      await waitBusy(B, A.id, true);
    });
    await step("typing indicator shows on the other side", async () => {
      await chatInput(A).pressSequentially("hel");
      await B.page.getByLabel("Stranger is typing").waitFor({ timeout: 5_000 });
      await chatInput(A).fill("");
    });
    await step("chat A → B delivered", async () => {
      await send(A, "hello from A");
      await text(B, "hello from A", 5_000);
    });
    await step("chat B → A delivered", async () => {
      await send(B, "hi from B");
      await text(A, "hi from B", 5_000);
    });
    const video = await step("video request + accept → remote video plays on both", async () => {
      await A.page.getByRole("button", { name: /video/i }).first().click();
      await text(B, /start video|video call\?|wants to (turn on|start) video/i);
      await B.page.getByRole("button", { name: /^accept$/i }).first().click();
      await Promise.all([remoteVideoPlaying(A), remoteVideoPlaying(B)]);
    });
    if (video) {
      // Regression: the video area grew to the camera's intrinsic height and
      // pushed the "End video" bar off-screen on short/wide desktop windows.
      await step("video controls stay on-screen in a short, wide window", async () => {
        await A.page.setViewportSize({ width: 1600, height: 420 });
        await A.page.waitForTimeout(300);
        const inView = await A.page
          .getByRole("button", { name: /end video/i })
          .first()
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.bottom <= window.innerHeight && r.top >= 0;
          });
        // The visible stage must stay within 16:9 so a very wide window can't
        // crop the stranger's face away.
        const stage = await A.page.evaluate(() => {
          const v = [...document.querySelectorAll("video")].find((x) => !x.muted);
          const r = v?.getBoundingClientRect();
          return r ? r.width / r.height : null;
        });
        await A.page.setViewportSize({ width: 1280, height: 800 });
        if (!inView) throw new Error("End video button is outside the viewport");
        if (!stage || stage > 16 / 9 + 0.01) throw new Error(`video stage aspect ${stage?.toFixed(2)} > 16:9`);
      });
      await step("end video → back to chat on both", async () => {
        await A.page.getByRole("button", { name: /end video/i }).first().click();
        await Promise.all([chatInput(A).waitFor({ timeout: 8_000 }), chatInput(B).waitFor({ timeout: 8_000 })]);
      });
    }
    await step("A ends chat → B's chat closes", async () => {
      await A.page.getByRole("button", { name: /^end( chat)?$/i }).first().click();
      await chatInput(B).waitFor({ state: "detached", timeout: 10_000 });
    });
    // B's transcript stays readable until B dismisses it (if the UI keeps it).
    await step("B's ended chat can be dismissed", async () => {
      const back = B.page.getByRole("button", { name: /back to the globe/i });
      if (await back.count()) {
        await text(B, "hello from A", 2_000);
        await back.click();
        await back.waitFor({ state: "detached", timeout: 3_000 });
      }
    });
    await step("after ending, both dots available again", async () => {
      await waitBusy(A, B.id, false);
      await waitBusy(B, A.id, false);
    });
    if (await step("reconnect after ending works", () => connect(A, B))) {
      await step("chat after reconnect", async () => {
        await send(B, "round two");
        await text(A, "round two", 5_000);
      });
      await step("B closes tab mid-chat → A's chat ends", async () => {
        await B.page.close({ runBeforeUnload: true });
        await chatInput(A).waitFor({ state: "detached", timeout: 25_000 });
      });
      await step("B's dot removed after clean leave", () => waitForMarker(A, B.id, false, 10_000));
    }
  }

  // Crash case: C vanishes without /api/leave ever reaching the server.
  const C = await user("C", 35.68, 139.69); // Tokyo
  await step("C enters", () => enter(C));
  await step("A sees C's dot", () => waitForMarker(A, C.id));
  await step("C crashes (no leave) → dot reaped by staleness", async () => {
    await C.ctx.setOffline(true); // so neither the pagehide beacon nor a poll gets out
    await C.ctx.close();
    await waitForMarker(A, C.id, false, 30_000);
  });
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
