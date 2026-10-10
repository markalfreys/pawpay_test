# Pulse — Notes

## Phase 1 — Make it run

**How I found the bugs:** I read every file end-to-end first, then wrote a
two-user browser test ([`e2e/two-users.mjs`](e2e/two-users.mjs),
`npm run test:e2e`). It drives headless Chrome with fake camera/mic and mocked
geolocation through join → connect → chat → video → end → reconnect →
tab close → crash. Against the untouched code it passed **14/19** checks, and
two of those passes only happened because an earlier step had already broken.
After the fixes it passes **20/20** (one check was added later for #10).

| # | Symptom | Root cause | Fix |
|---|---------|------------|-----|
| 1 | Following the README on a fresh clone, every API call fails with `Cannot find module '.prisma/client/default'` | Prisma 7's `db push` no longer runs `generate`, and `@prisma/client` has no install hook | `postinstall: prisma generate`. `prisma.config.ts` also no longer uses `env()`, which throws when `DATABASE_URL` is unset — with the new hook that would have broken `npm install` before `.env` exists |
| 2 | Dots stay on the map long after people leave *(the README example)* | The poll "heartbeat" was `updateMany({ where: {} })`, so it refreshed `lastSeen` on **every** row on every poll and nothing ever went stale | Heartbeat only the caller (`where: { id }`) |
| 3 | Chat messages never arrive | Sender sent `{ t: "msg" }`; receiver only accepts `t === "chat"` | Send `"chat"` |
| 4 | After the first chat ends, both users stay "busy" forever and every new request is auto-declined | `/api/signal` cleared `busy` on `decline` (when nobody is busy) but never on `end` | Clear on `end`. `decline` no longer touches `busy`: a client auto-declines while it is mid-chat, and that used to mark it as free |
| 5 | Connection setup is unreliable | ICE candidates that arrive before the offer are queued, but the queue was flushed *before* `setRemoteDescription`, so `addIceCandidate` threw and the error was swallowed | Flush after `setRemoteDescription`. Signals now go through a serial queue, so a candidate can't race a description that is still being applied |
| 6 | If the stranger closes their tab or loses network, your chat stays open; local failures never told the server, so you stayed "busy" for everyone | No data-channel `close` handling, no check that the partner still exists, and failure teardowns didn't send `end` | Handle data-channel `close`. If the partner is missing from 2 consecutive polls, tear down. Every local teardown now sends `end`. A 25 s connect timeout catches handshakes that never finish |
| 7 | A user whose row was reaped (tab throttled in the background, or restored from bfcache after `pagehide` → leave) stayed invisible for the rest of the session | The poll heartbeat only updates rows that still exist | Poll returns `present: false` and the client re-joins |
| 8 | Without a Mapbox token you get a blank map and no hint | A hard-coded placeholder token was the fallback, so `!TOKEN` was never true | Removed the fallback, so the setup message shows |
| 9 | An unanswered video request leaves "Waiting…" up forever with Video disabled; both users tapping Video at once deadlocks | No timeout or cancel; the two crossing requests were both ignored | Cancel button + 30 s timeout. Crossing requests count as mutual consent. `startVideo()` is idempotent, so the camera can't be added twice |
| 10 | On desktop the video call crops the stranger to the top of their head, and **End video is unreachable** (found in manual testing with a real webcam; the test's fake camera is small enough to hide it) | The video area was a flex item with the default `min-height: auto`, so it grew to the camera's height and pushed the button bar below the viewport. `object-cover` then cropped a 4:3 feed to fit a ~2:1 window | `min-h-0` on the video area and `shrink-0` on the bar. The feed still fills the screen (`cover`, like a phone call). On wide screens (≥1280 px) the chat stays docked beside the video, which also lets you keep texting during a call, so the video area ends up close to the camera's shape and barely crops. The video area is capped at 16:9, with a blurred copy of the feed beside it on ultra-wide windows, so it can never crop heavily. I tried letterboxing (`contain`) first and rejected it: empty bars on both desktop and mobile. The self-view is mirrored. The E2E test now checks a short, wide viewport |
| 11 | Smaller issues | — | Join failures now show an error on the gate instead of dropping you onto a dead map. Falls back to a coarse location fix when high accuracy times out (common on desktops). A new notice no longer gets cleared early by an older one's timer. Tapping a busy dot no longer sends a request that is certain to be declined. Markers move if a peer's position changes |

**Performance** (the main reason "tap → connected" felt slow):

- Each poll ran 5 sequential queries (≈1.5 s per poll from my machine to a
  us-east-1 Neon database). It now runs 3 concurrent queries. The mailbox is
  drained with one atomic `DELETE … RETURNING` instead of read-then-delete.
  Garbage collection is throttled and runs after the response via `after()`.
  Result: ≈0.67 s per poll from the same machine.
- The client polls every 400 ms only while a handshake is in flight, and every
  1.5 s otherwise.
- Once the data channel is open, renegotiation (turning video on/off) goes
  over the data channel instead of through the server. Video start went from
  4.3 s to 0.6 s in the E2E test, and the server never sees those SDPs.

**Gotcha:** bug #2 runs on the server. While testing, an old build pointed at
the same database kept refreshing every row, so no dot could expire even with
the fix. Make sure no old deployment shares the database.

## Phase 2 — Make it good

- **Auto-framing.** The map opened at a fixed zoom around you, so people in
  your own city were one overlapping blob and you had to keep zooming in. Now
  the camera fits you and every peer on screen, and re-frames when people join
  or leave. It caps at neighbourhood zoom (12.5), so dots a few km apart
  stay distinct and the map still shows context. After it has framed someone,
  dragging or zooming yourself turns it off, so it never fights you. Gestures
  made before anyone appears don't count: an early habitual zoom shouldn't
  disable it before it ever helps. **Show everyone** re-frames and turns
  auto-framing back on.
- Moved the online counter to the top-left. At the bottom-left it sat on the
  Mapbox logo, which their terms require to stay visible, and under the
  Next.js dev badge.

_More to come._

## Phase 3 — Make it secure

_TODO_

## Phase 4 — Make it better

_TODO_
