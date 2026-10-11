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
  with everyone online glowing on it before you join. (An "N people online
  now" badge sat above the logo at first; I removed it because it read like
  a template landing page, and the dots already show it.) It starts facing your side of the planet, using your timezone as a free,
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
    people and never clickable. The layer fades out the moment you enter, so the live map only ever
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

**How I reviewed it:** I read every route as an attacker who starts with only
what the app hands out. That turned out to be a lot, because `/api/poll`
returns every online person's id. I then wrote
[`e2e/api-security.mjs`](e2e/api-security.mjs) (`npm run test:security`):
14 checks, each replaying one of the attacks below against a running
instance. All pass, and the two-user browser test still passes 23/23.

Ranked by what an attacker could actually do to Pulse, not by CVE score:

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | Critical | **The id on every dot was also the password.** `/api/poll` sends every peer's id to everyone, and every endpoint trusted whatever id the caller sent. One poll was enough to: drain anyone's mailbox (`/api/poll?id=`), intercepting their connection requests, SDP and ICE candidates (which carry IP addresses) and answering in their place; send signals as anyone (`fromId` came from the body); kick anyone off the map (`/api/leave`); and move anyone's dot (`/api/join` upserts) | Each tab now has a secret key, and its public id is a SHA-256 hash of that key ([`lib/session.ts`](lib/session.ts)). Every call authenticates with the key in the `Authorization` header (not the URL, so it stays out of logs). The server works out who you are from the key and ignores any id you claim. The public id can't be turned back into the key. Because the id is derived rather than issued, there's no new secret to configure and no extra table |
| 2 | High | **Signals weren't checked against any relationship.** Even as yourself you could: send a forged `accept` to anyone, marking you both busy (one call per user turns the whole map "busy"); hang up anyone, because `end` freed both ids unconditionally (also a real bug: someone whose request to you timed out freed you mid-chat with someone else); and send `offer`/`ice` to someone who never accepted, against "no way to message someone before they accept" | The server now tracks who is linked to whom (`Presence.peerId`) and relays only signals that fit. `request` goes only to someone online and free, and only from someone on the map. `accept`/`decline` go only to someone whose request to you is pending. `offer`/`answer`/`ice` go only within an accepted connection, and `end` only to whoever you're linked to. `accept` links both sides in one conditional `UPDATE`. Anything else gets a 409 and is never stored |
| 3 | High | **The 1–3 km privacy offset could be averaged away.** Every join drew a fresh random offset, and the client re-joins under the same id whenever its row is reaped (e.g. a background tab). The offsets point in random directions, so their average converges on the real location: roughly 0.4 km off after 25 samples, 0.2 km after 100. With #1, an attacker could collect samples quickly by kicking the victim every few seconds | The offset is now seeded from the session key. It's still new every session, as the requirements say, but identical for every re-join within one, so there's nothing to average |
| 4 | Medium | **No rate limits.** One script could flood the database (each poll is 3 queries) or ring the same person over and over (each request means a prompt, a chime and a vibration) | Per-IP limits on join, poll, signal and connection requests, plus at most 3 requests a minute to the same person ([`lib/ratelimit.ts`](lib/ratelimit.ts)) |
| 5 | Medium | **Signal payloads were relayed as-is**: any string up to 64 KB, and ids weren't validated | Ids must be well-formed public ids. Only `offer`/`answer`/`ice` carry a payload, and it must have the right shape. The server rebuilds it from just the expected fields before relaying it, so a stranger can't push arbitrary data through. Max 16 KB |
| 6 | Medium | **Next.js 16.2.7 had critical advisories**, including unauthenticated RCE in the image optimizer, plus SSRF and DoS issues. Real exposure here was low: Pulse doesn't use `next/image`, `next/og`, AVIF or Windows hosting. But `/_next/image` is on by default and the patch costs nothing | Upgraded to 16.3.8, which fixes every listed advisory (I chose it over 16.4.0, which has the same fixes but came out only five days ago) |
| 7 | Low | **No framing protection** on a page that asks for your camera, so another site could frame it and trick you into clicking Accept (clickjacking) | `frame-ancestors 'none'` and `X-Frame-Options: DENY`; a `Permissions-Policy` that limits camera, mic and location to Pulse itself; `nosniff` |

**Known, not fixed**

- **Your IP address goes to whoever you connect with.** That's inherent to
  peer-to-peer WebRTC. Hiding it needs a TURN relay
  (`iceTransportPolicy: "relay"`), an external service the requirements rule
  out. It now happens only after you accept. Before #1 and #2, anyone could
  collect strangers' ICE candidates.
- **No report.** Phase 4 adds a one-tap block for the session ("Block this
  person" on a wave), but there's no way to report someone: with no accounts,
  there's nobody to act on.
- **Averaging across sessions.** Someone who uses Pulse often from home gets
  a new offset each session. If an observer can tell those sessions are the
  same person (say, the only dot in a small town every evening), averaging
  still works. The next step would be to snap the real location to a grid of
  about 1 km before applying the offset, so the average only reveals the grid
  cell. Cells up to about 1.4 km still keep every dot within the required
  1–3 km.
- **Rate limits are per server instance.** They stop one noisy client. For
  real volumetric abuse, add Vercel Firewall rate-limit rules, which are built
  into Vercel, so no extra service.
- **Locations can't be verified.** Anyone can put their dot anywhere.
  Accepted.
- **No strict Content-Security-Policy.** A `script-src` policy needs
  per-request nonces (via `proxy.ts`) plus the worker and blob allowances
  Mapbox needs. Worth doing, but not quick to get right.
- **The Mapbox token is public by design** (`NEXT_PUBLIC_`). Restrict it to
  the production URL in the Mapbox dashboard.
- **19 npm audit findings remain: none critical, and none in the deployed
  app.** They're in the Prisma CLI (its local dev database pulls in `hono`,
  `mysql2` and others), ESLint, and build-time CSS tooling. Prisma's suggested
  fix is a downgrade to v6, so I left them.

**Cost and rollout.** Each signal now does one extra database lookup to check
the link, which takes milliseconds when Vercel and Neon are in the same
region. Before deploying, run `npx prisma db push` against the production
database: it adds the nullable `Presence.peerId` column, and the same change
is also in `prisma/migrations`.

## Phase 4 — Make it better: Waves 👋

**What it is.** A quiet, consent-first hello. Tapping a dot now opens a card
with two choices: **Wave** or **Ask to chat**.

- A wave flies across the globe as a comet and lands on their dot. They get no
  pop-up and no chime: just a 👋 on your dot and a small card.
- If they **wave back**, you're connected straight away. You both said hi, so
  nobody has to accept anything.
- An unanswered wave fades after two minutes. You can also take a wave back,
  and it disappears from their screen too.
- **No thanks** turns down that wave. The sender's wave clears, so they can
  try again later.
- **Block this person** ignores their waves and requests for the rest of the
  session, unless you reach out to them yourself later.

**Why.**

- **Alive.** The only way to interact with a dot used to be a full connection
  request, which is a big ask. Most people looking at a globe of strangers
  aren't ready to commit to a conversation; they want to know someone's there.
  A wave is a lightweight action that makes things happen on the map: real
  hellos crossing the globe. The entry screen's greetings are illustrative;
  waves are the real thing.
- **Safe.** A request interrupts with a full-screen dialog and a chime, which
  makes it a tool for harassment (Phase 3 had to rate-limit it). A wave
  interrupts nobody and carries no text, so there's nothing to abuse, and a
  chat only opens once both people have opted in. "Block this person" gives
  a one-tap block, which Phase 3 listed as missing. An unanswered wave simply
  fades.

**How it works.**

- `wave` is a new signal type. The server holds it to the same bar as a
  request (the sender is on the map, the target is online and free),
  rate-limits it to two a minute per person, rejects any payload, and never
  links the two people. `unwave` clears the wave between two people ("No
  thanks", or taking a wave back). Since the sender is authenticated, it can
  only ever clear a wave its sender is part of.
- Waving back is a normal `request`. The first person's client sees a request
  from someone it waved at and accepts it on its own, since it already said
  hi, so the Phase 3 link rules didn't change. This only works because Phase 3
  made `fromId` unforgeable: nobody can fake a wave-back from someone you
  waved at.
- When two requests cross (both people ask at once, a wave back crosses an
  "Ask to chat", or two waves are noticed together), the lower public id's
  request stands and the other side accepts it. This also fixed an older bug:
  two crossing requests used to decline each other, so nobody got a chat
  although both had said yes.
- A receiver's copy of a wave expires 10 s before the sender's, so waving
  back can't reach someone whose wave has just run out. A wave from someone
  who has since started another chat is dropped on both sides.
- A card that appears on its own (a wave arriving) ignores clicks for its
  first 600 ms, so a click aimed at the card it replaced can't wave back to a
  stranger by accident.
- Only the two people involved ever see a wave. The comet reuses the entry
  screen's great-circle code ([`lib/ambient.ts`](lib/ambient.ts)) in its own
  layer ([`lib/waves.ts`](lib/waves.ts)). Arcs that cross the antimeridian are
  drawn the short way, and reduced-motion users get the 👋 badge without the
  animation.

**Decisions.**

- A direct request now takes one extra tap, because tapping a dot opens the
  card instead of calling straight away. Offering the gentler option at the
  moment you choose is worth that tap.
- "No thanks" and "Block" are separate. At first, "No thanks" also blocked
  the sender for the session, which in testing felt broken: the sender
  couldn't wave again and didn't know why. Now a no is just a no, and
  blocking is its own, explicit action.
- A block lives in the browser and lasts the session. The server never learns
  who blocked whom, which fits "nothing stored". A blocked person's requests
  are declined just like a busy person's, so they can't tell.
- Waves to people already in a conversation are refused rather than queued;
  a hello that lands mid-chat is noise.
- While I was there: on phones, the calling card and the new card now sit
  above the Mapbox logo, which has to stay visible.

**How I checked it.** The browser test now has 32 checks: A waves, B sees it
with no prompt, B says no thanks, A waves again, B waves back, and the chat
opens on both sides with no accept step. Two people asking each other at the
same moment get a chat. It also
fails on any uncaught error in a page. A production build only logs those to
the console, and that's how a crash in the comet animation got past the
first version of these tests. The security test has 17: you can't wave at
someone in a conversation, or while you're in one; a flood of waves gets a
429; and waves and unwaves can't carry text. I also ran a code review over
the wave logic and fixed what it found, mostly races between cards, waves
and requests. And I took screenshots of every wave state at 1440×900 and
390×844 and adjusted from those (a quieter button after you've waved, and
the logo fix above).

**Next, with more time.**

- **Block from inside a chat.** The same block, one button away in the chat
  header.
- **A live count of waves** ("38 hellos crossed the globe this hour") on the
  entry screen, so its "alive" layer is backed by real, anonymous numbers.
- **A gentle cue for waves in background tabs.** Today they're silent by
  design, so you can miss one if Pulse isn't in front.
