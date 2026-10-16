# Chat App

A real-time chat app (users, rooms, messages) built around
**message-delivery correctness** rather than CRUD breadth: gap-free per-room
sequence numbers, cursor (never offset) pagination, JWT refresh-token rotation
with reuse detection — and, in v2, a Socket.IO transport on top that is
designed to survive the things real networks do: dropped connections, silent
network death, token expiry mid-conversation, and server restarts.

v1 was a polling app (the client asked "anything new?" every few seconds). v2
replaces the polling with a persistent connection. Nothing from v1 was
thrown away: the sockets call the same functions the HTTP routes do, so
authorization, idempotency and ordering have exactly one implementation.

**Deployed on Render** (free tier, so the API cold-starts in about a minute
after 15 idle minutes — expected, not a bug): client
[chat-app-client-j5j9.onrender.com](https://chat-app-client-j5j9.onrender.com),
API [chat-app-server-j0mr.onrender.com](https://chat-app-server-j0mr.onrender.com)/health.
See [`DEPLOYMENT.md`](./DEPLOYMENT.md) — including the free-database expiry
that can take a deployment down, and how to check it end to end with
`npm run smoke:live`.

Design docs: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (v1, still the foundation),
[`ARCHITECTURE_V2.md`](./ARCHITECTURE_V2.md) (the real-time layer, with the
reasoning and the bugs found along the way), and the build plans
[`ROADMAP.md`](./ROADMAP.md) / [`ROADMAP_V2.md`](./ROADMAP_V2.md).

## What v2 does

| Concern | Behaviour |
|---|---|
| Delivery | `send_message` → `message_ack` to the sender, `new_message` pushed to the room. A stable `client_message_id` makes every resend idempotent: one row, however many times it is sent. |
| Offline | The client queues unsent messages and replays them in order on reconnect; a rate-limited send stays queued and retries after the advertised delay. |
| Catch-up | Every join carries the client's cursor; the server returns exactly what was missed (paged, so any gap size works). The server joins the live room *before* querying, so nothing can fall between history and live — see ARCHITECTURE_V2 §7 for the bug that taught this. |
| Presence | Reference-counted per user (two tabs = one person) with a grace period, so a page refresh never flickers anyone offline. |
| Dead connections | An app-level heartbeat detects a connection that died silently (no FIN, no RST) and cleans it up. |
| Typing | Pure relay — zero database writes — with an auto-clear safety net on the receiver. |
| Rate limiting | Per-user token buckets shared by HTTP and sockets. A refused event gets one `rate_limited` notice; the connection is never dropped. |
| Authorization | Membership is checked at join *and* enforced on revocation: leaving a room evicts every one of that user's live sockets from it immediately, and a join racing a leave cannot slip through. |
| Auth | Short-lived access token + rotating refresh token with reuse detection. A socket re-authenticates *on the same connection* before its token expires. |
| Deploys | `SIGTERM` → clients are told (`server_shutdown`), reconnect immediately to the new instance, and replay what they missed. |

## Testing

```bash
cd server && npm test      # 18 files, 94 tests, ~1 minute, nothing to install or start
cd client && npm test      # 89 tests, a few seconds
```

`npm test` needs no Docker and no running server. It starts an in-memory
Postgres-protocol database (PGlite), runs the real migrations against it, and
exercises the real app two ways:

- **HTTP integration (v1)** via [supertest](https://github.com/ladjs/supertest):
  register/login/refresh, **reuse detection** (replaying a rotated refresh token
  revokes the whole family), membership authorization, idempotent send, cursor
  pagination, validation, error shapes, rate-limit 429s.
- **Real-time integration (v2)**: the Express + Socket.IO stack bound to a real
  port and driven by `socket.io-client`. Covers reconnect-and-replay
  (exactly-once, including a message cut at the instant of disconnect),
  catch-up correctness (multi-page gaps, a message landing between query and
  join, live pushes interleaved with paging), presence reference counting and
  the grace period, heartbeat detection of a silently dead connection, rate
  limiting (per-user budget, one notice, no disconnect), reauth surviving token
  expiry, membership revocation (an ex-member stops receiving immediately), and a full rolling-deploy shutdown. The client's backoff schedule is
  tested with fake timers against the real Socket.IO manager.

What each suite proves, and the mutation checks showing the tests can actually
fail, are in [`ARCHITECTURE_V2.md` §13](./ARCHITECTURE_V2.md).

**Against a deployment** (the part local tests cannot cover — a real hosting
proxy has to pass the WebSocket upgrade through):

```bash
cd server
npm run smoke:live -- https://your-api.onrender.com
npm run smoke:live -- https://your-api.onrender.com --watch-deploy   # then trigger a deploy
```

**What `npm test` deliberately does not cover:** true concurrency. PGlite is
single-connection, so the scenarios that need real simultaneous load live as
standalone scripts that run against a real Postgres:

```bash
docker compose up -d && npm run migrate:up && npm run dev   # in one terminal
npm run test:concurrency            # 50 concurrent sends -> gapless 1..50
npm run test:scrollback-stability   # pagination correctness under concurrent insert
npm run test:refresh-race           # concurrent refresh calls on the same token
npm run test:register-race          # concurrent registration with the same email
npm run test:leave-race             # concurrent /leave calls stay idempotent
npm run test:hardening              # same hardening checks as `npm test`, against a live server
```

One command for correctness, a documented second one for what needs real
infrastructure — that split is the honest answer, not a workaround.

## Getting Started (server)

```bash
cd server
cp .env.example .env

# start Postgres locally
docker compose up -d

npm install
npm run migrate:up
npm run seed
npm run dev
```

Verify the DB seeded correctly:

```bash
docker compose exec postgres psql -U chatapp -d chatapp -c '\dt'
docker compose exec postgres psql -U chatapp -d chatapp -c 'select * from room_members;'
```

You should see the tables and a `general` room with `alice` (owner) and `bob`
(member). The API listens on the port in `server/.env` (default `4000`);
Socket.IO shares that port.

Optional tuning (all have production-safe defaults; the test suite shortens
them): `SOCKET_PING_INTERVAL_MS`, `SOCKET_PING_TIMEOUT_MS`,
`PRESENCE_GRACE_PERIOD_MS`, `TOKEN_EXPIRY_WARNING_LEAD_MS`,
`SHUTDOWN_ACK_TIMEOUT_MS`, `SHUTDOWN_HARD_TIMEOUT_MS`, `DB_POOL_MAX`.

## Getting Started (client)

In a second terminal, with the server still running:

```bash
cd client
cp .env.example .env   # VITE_API_URL should point at the server, e.g. http://localhost:4000
npm install
npm run dev
```

Open the printed `localhost:5173` URL. Register two users in two browser
windows (one normal + one incognito, since sessions are per-browser-profile),
join the same room from both, and send messages: they appear in the other
window immediately, with typing indicators and online/offline presence. To
watch the resilience, stop the server mid-conversation (messages queue and the
UI says so), start it again (they send, in order, exactly once), or close one
window and watch the other mark that user offline a few seconds later.

## Stack

Node.js, TypeScript, Express, Socket.IO, Postgres, React 19 + Vite + React
Router. No ORM — raw SQL via `pg`, versioned through `node-pg-migrate`. See
`ARCHITECTURE.md` and `ARCHITECTURE_V2.md` for why.
