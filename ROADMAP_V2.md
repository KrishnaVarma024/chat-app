# Roadmap — v2 (WebSockets)

Build order for the upgrade described in `ARCHITECTURE_V2.md`. Continues
the phase numbering from `ROADMAP.md` (v1 was Phases 0–8) since this is
one project's history, not a restart. Same rule as v1: no phase is "done"
until its DoD passes against real infrastructure, not until the code
merely exists.

## Core Features

What v2 actually delivers, end to end:

- **Socket.IO replacing HTTP polling** for message delivery — same
  Postgres schema and core logic as v1, new transport.
- **Live typing indicators** — ephemeral, throttled, never persisted.
- **Online/offline presence** — reference-counted per user (handles
  multi-tab/multi-device), with a grace period so a page refresh doesn't
  flicker someone's status.
- **Reconnection with exponential backoff + jitter** — no thundering
  herd against a server that just came back up.
- **Client-side offline message queue with guaranteed-once-delivered
  replay** — nothing sent while disconnected is lost, and idempotency
  (already built in v1) makes replaying a message that actually got
  through safe.
- **Heartbeat ping/pong** — detects a dead connection the OS hasn't
  noticed yet, on both ends.

Plus the additions that make this a complete production-shaped system
rather than a features checklist — each one chosen because it either
closes a real gap the six items above would otherwise leave open, or
teaches a concept worth being able to defend in a review:

- **Reconnect catch-up** using the same sequence-number cursor v1's poll
  already relied on — closes the exact gap a push-only model would
  otherwise reopen (a client that was disconnected has to recover
  everything it missed, not just resume live updates).
- **Auth handshake + mid-connection token expiry handling** — a socket
  can outlive a 15-minute access token; reauthenticating in place beats
  forcing a reconnect just to rotate a token.
- **Socket-level rate limiting**, reusing v1's token bucket, applied
  explicitly per event instead of via middleware (sockets have no
  middleware chain).
- **Realtime-aware testing strategy** — `socket.io-client` against a
  real bound port, plus fake timers for deterministic backoff tests.
- **Graceful shutdown on `SIGTERM`** — a deploy shouldn't cost every
  connected client a full backoff cycle to notice the server's back.
- **Horizontal scaling explicitly deferred, not ignored** — documented
  in `ARCHITECTURE_V2.md` §12 with the specific mechanism
  (`@socket.io/redis-adapter`) that would be needed if this ever runs on
  more than one instance.

## Phase 9 — Socket.IO Foundation & Auth Handshake

**Build:** mount Socket.IO on the existing HTTP server, handshake
middleware verifying the JWT access token (§4), `join_room`/`leave_room`
events reusing v1's membership-check logic refactored into a shared
function callable from both Express and socket handlers.

**Done when:** an authenticated client connects and joins a room it's a
member of; connecting with no/invalid/expired token is rejected at the
handshake (never gets a `socket.id`); joining a room the user isn't a
member of returns an `error` event with the same `FORBIDDEN`/`NOT_FOUND`
codes v1's HTTP API uses, never a silent join.

## Phase 10 — Real-Time Message Send & Receive

**Build:** `send_message` socket event wrapping v1's exact atomic
sequence + idempotent insert function; `message_ack` back to the sender;
`new_message` broadcast to the rest of the room (§5).

**Done when:** two connected clients in the same room see a message
appear on both sides with no polling involved; emitting the same
`clientMessageId` twice (simulating a retry) produces exactly one row in
`messages` and both emits resolve with the same sequence number.

## Phase 11 — Reconnection: Backoff + Offline Message Queue

**Build:** client-side exponential backoff + jitter configuration (§6);
ordered offline message queue (in-memory + `localStorage`), replayed in
full on `connect`/`reconnect`.

**Done when:** disconnecting the network mid-send queues the message
locally; on reconnect, the queue replays in order and every message
lands in the database exactly once, including the message that was
"in flight" at the moment of disconnect (proving idempotency, not just
retry, is what prevents the duplicate).

## Phase 12 — Missed-Message Catch-Up on Reconnect

**Build:** `join_room` extended to accept `sinceSequence`; server runs
v1's cursor query and emits a `catch_up` batch before the socket starts
receiving live events for that room (§7), including `has_more` paging
for large gaps.

**Done when:** Client A disconnects; Client B sends several messages
into the room; Client A reconnects and receives exactly the missed
messages, in order, with no gaps and no duplicates against what a client
that stayed connected saw in real time. A gap larger than one page
correctly triggers a follow-up catch-up fetch instead of silently
truncating.

## Phase 13 — Heartbeat & Presence

**Build:** tuned `pingInterval`/`pingTimeout` (§8); reference-counted
presence map (`userId -> Set<socketId>`) with online/offline
broadcasts and a grace period before an offline broadcast fires (§9).

**Done when:** a connection killed without a clean disconnect (simulated
dead connection, not a graceful close) is detected and cleaned up via
heartbeat timeout, not left hanging indefinitely; opening two tabs as
the same user and closing one leaves them "online"; closing both flips
to "offline" only after the grace period, never immediately; a
disconnect-then-reconnect within the grace window produces zero
`presence` broadcasts.

## Phase 14 — Typing Indicators

**Build:** client-side throttled `typing_start` / explicit
`typing_stop` (§10); server relay with zero database access; receiving-client
auto-clear timeout as a safety net against a stuck indicator.

**Done when:** typing shows and clears correctly across two clients; a
client that disconnects mid-typing (never emits `typing_stop`) still
has its indicator auto-clear on the receiving side within the timeout;
a check of row counts confirms zero writes to any table during a typing
burst.

## Phase 15 — Hardening

**Build:** v1's token-bucket limiter applied explicitly to `send_message`
and `typing_start` (§11); mid-connection reauth flow for access-token
expiry (§4); `SIGTERM` handling that broadcasts `server_shutdown` before
closing connections (§14).

**Done when:** flooding `send_message` or `typing_start` gets
rate-limited (an event to that socket, not a disconnect) without
affecting other users; simulating an access-token expiry mid-connection
triggers `token_expiring` → client reauth → connection survives with no
gap in delivery; sending `SIGTERM` to the process results in connected
clients reconnecting immediately rather than waiting out a backoff
delay.

## Phase 16 — Tests, Docs, Redeploy

**Build:** `socket.io-client`-based integration suite against a real
bound port + the existing PGlite harness (§13), fake-timer-based
deterministic backoff tests, `ARCHITECTURE_V2.md`/`README.md`/
`DEPLOYMENT.md` finalized, redeployed to Render.

**Done when:** the full v2 test suite (reconnect-and-replay,
catch-up correctness, presence reference counting, rate limiting) passes
in one command; a live smoke test against the actual Render deployment
confirms real-time delivery, typing, and presence all work in
production — WebSocket behavior through a real hosting platform's proxy
is a genuinely new risk vs. v1 and has to be verified for real, not
assumed from local testing.

---

**Workflow:** unchanged from v1 — after each phase's DoD passes against
real infrastructure, review happens in chat as B/M/H/T questions framed
the way a senior would probe the actual implementation. Only source code
and legitimate docs (this file, `ARCHITECTURE_V2.md`, `README.md`,
`DEPLOYMENT.md`) get committed and pushed; exercise answers stay local.
