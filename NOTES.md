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

**Direction.** Pulse is "a living globe", so I designed it as a night-side
view of Earth from space. Everything is dark and glassy so the people, glowing
dots, are the brightest thing on screen. A single warm accent (a coral → amber
"heartbeat" gradient) marks every primary action. The type pairs Instrument
Serif for the few moments of voice (wordmark, prompts, "Say hello") with Geist
for the UI. The layout already loaded Geist, but a stray `font-family: Arial`
in `globals.css` was overriding it.

**The flow, screen by screen**

- **Entry.** Instead of a black page with a button, you land on the real
  globe, slowly spinning (Mapbox globe projection with atmosphere and stars),
  with everyone online glowing on it before you join: "5 people online now".
  It starts facing your side of the planet, using your timezone as a free,
  permission-free hint. A new read-only `/api/globe` feeds it: anonymous (no
  ids), coordinates rounded on top of the privacy offset, and CDN-cached for a
  few seconds so gate traffic doesn't hit the database. Copy is short and
  honest about privacy (no sign-up, 1–3 km offset, nothing stored). Location
  errors explain how to recover.
- **An empty globe shouldn't look dead.** Behind the real dots, the gate
  globe shows an *illustrative* layer (`lib/ambient.ts`):
  - Twinkling warm city lights clustered around ~140 real population centres.
  - Every second or so, a "message" crosses between two of them: a comet
    along a great-circle arc, then a ripple and a greeting in a local
    language ("hola", "こんにちは", "kumusta"…), a nod to "Say hello."
  - I kept it honest: these are much smaller than the heartbeat dots of real
    people, never clickable, and the "N online now" count stays truthful.
    The layer fades out the moment you enter, so the live map only ever
    shows real people.
  - It renders with Mapbox layers updated at ~30 fps and only animates the
    side of the globe facing you. Reduced-motion users get static lights.
- **Arrival.** Clicking Enter fades the copy out and the camera flies from
  space to you. Your marker is now your *public* position (the offset dot
  everyone else sees, returned by `/api/join`), not your real location, so
  what you see is what others see.
- **The map.** Dots beat with a staggered double "lub-dub" ring, each on its
  own phase so the globe shimmers instead of blinking in sync. They pop in when
  someone joins and fade out when they leave. Busy people are dimmed with a slow
  dashed orbit and can't be tapped. The person you're calling or talking to is
  highlighted. Each stranger keeps one colour from a curated palette across
  their dot, their orb in prompts and the chat header. Tooltips say "Say hi" /
  "In a conversation".
  - Markers are built as a positioned root plus an animated child: Mapbox
    writes `transform` on the root, so the old `.pulse-dot:hover { transform }`
    fought the map's positioning.
- **Auto-framing.** The map used to open at a fixed zoom, so people in your
  own city were one overlapping blob. The camera now frames you and your
  *nearest cluster*: everyone up to 4× your nearest neighbour's distance
  (25 km minimum, 3,000 km maximum), capped at neighbourhood zoom. It
  re-frames on joins and leaves. On a globe, "fit everyone" is the wrong goal:
  a box from New York to Sydney centres on Africa and shows nobody.
  - Once it has framed someone, your own drag or zoom turns auto-framing off,
    so it never fights you. Gestures before anyone appears don't count.
    **Show people near you** and **Find me** give the camera back.
- **Requests.** Calling someone shows a non-blocking card with their orb and a
  draining 30 s bar, so the globe stays usable. An incoming request is a
  focused dialog with the requester's orb, so you can find their dot. It has
  its own countdown, Esc declines, and it plays a soft synthesised two-note
  chime (Web Audio, unlocked by the Enter click), buzzes on phones and flags
  the tab title if Pulse is in the background. Copy is kind: "They can't talk
  right now", "No answer — maybe try someone else?".
- **Chat.** Full-screen sheet on phones, floating glass card on desktop. It
  has grouped bubbles, a live "connecting / connected · peer-to-peer" status,
  a typing indicator (throttled data-channel ping), system lines ("Video call
  started"), a 1,000-character limit and long-word wrapping. When the *other*
  person leaves, the transcript stays readable with "Stranger left the chat"
  and **Back to the globe**, instead of being yanked away mid-sentence.
- **Video.** Mic and camera toggles flip `track.enabled`, so they're instant
  with no renegotiation. When the stranger turns their camera off, you see
  "Their camera is off" rather than a frozen black frame. The camera now
  requests 720p (16:9) instead of the 640×480 default. On desktop the call is
  a floating card with the chat docked beside it. The "waiting for video"
  state is an inline banner in the chat rather than a floating pill.
- **Layout and accessibility.** Safe-area insets (`viewport-fit=cover`) for
  notched phones. The online counter moved off the Mapbox logo, which their
  terms require to stay visible, and the gate's scrims stop short of the
  bottom edge for the same reason. Icon buttons have labels, dialogs are
  `role="dialog"`, toasts are live regions, focus rings are visible, and
  `prefers-reduced-motion` turns off the heartbeat, spin and transitions.
- **Clean-up.** Removed the create-next-app leftovers (default favicon, unused
  SVGs) and added a Pulse ECG icon. The only new dependency is `lucide-react`
  for icons.

**How I checked it.** The E2E test grew to 23 checks (typing indicator, ended
transcript, auto-framing). I also scripted a screenshot tour of every state
at 1440×900 and 390×844 and iterated on what I saw. That caught the Mapbox
logo hidden behind the gate copy on mobile, the "fit everyone" globe
centring on Africa, and an orb pulse that clipped inside its card.

## Phase 3 — Make it secure

_TODO_

## Phase 4 — Make it better

_TODO_
