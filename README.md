# Chat App

A polling-based chat backend (users, rooms, messages) built around
messaging-delivery correctness rather than CRUD breadth: gap-free
per-room sequence numbers, cursor/keyset pagination, and JWT
refresh-token rotation with reuse detection.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the system design and
[`ROADMAP.md`](./ROADMAP.md) for the build plan.

## Status

Phases 0–7 complete: schema, register/login, refresh-token rotation with
reuse detection, rooms & membership, atomic sequenced/idempotent message
send, cursor pagination (poll + scrollback), the React frontend (auth,
room list, polling chat view, infinite scroll, optimistic send), and
hardening (per-user token-bucket rate limiting on send/poll, request-id
propagated through every log line for a request, a centralized error
handler with a consistent `{ error: { code, message } }` shape, and zod
input validation on every route). Phase 8 (automated tests + docs) is
done; deployment is the remaining piece — see `ROADMAP.md` for the full
plan and each phase's definition of done.

## Testing

`cd server && npm test` runs the full integration suite in one command —
no Docker, no manual setup. It spins up an in-memory Postgres-protocol
server (PGlite), runs the real migrations against it, and exercises the
real app through every layer (routing, validation, auth, rate limiting,
the database) via [supertest](https://github.com/ladjs/supertest). This
covers register/login/refresh, **reuse detection** (replaying a rotated
refresh token revokes the whole token family), room membership
authorization, message send + idempotent retry, **cursor pagination**
correctness (poll and scrollback), and the Phase 7 hardening behaviors
(malformed JSON, validation errors, rate-limit 429s + `Retry-After`,
request-id propagation).

What it deliberately does **not** cover: true concurrent access. PGlite
is architecturally single-connection, so it can't exercise a genuine race
(this came up in nearly every phase of building this). The two scenarios
that specifically need real concurrency — **contiguous sequence numbers
under 50 simultaneous sends** and **pagination stability while inserts
happen mid-scroll** — live as standalone scripts that run against a real
Postgres instead:

```bash
docker compose up -d && npm run migrate:up && npm run dev   # in one terminal
npm run test:concurrency            # 50 concurrent sends -> gapless 1..50
npm run test:scrollback-stability   # scrollback correctness under concurrent insert
npm run test:refresh-race           # concurrent refresh calls on the same token
npm run test:register-race          # concurrent registration with the same email
npm run test:leave-race             # concurrent /leave calls stay idempotent
npm run test:hardening              # same hardening checks as `npm test`, against a live server
```

This split — one command for correctness, a documented separate one for
scenarios needing real infrastructure — is itself the honest answer, not
a workaround: `npm test` proves the logic is right; the concurrency
scripts prove it holds under real simultaneous load, which needs a real
database to mean anything.

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

You should see six tables and a `general` room with `alice` (owner) and
`bob` (member). The API server listens on the port set in `server/.env`
(default `4000`).

## Getting Started (client)

In a second terminal, with the server still running:

```bash
cd client
cp .env.example .env   # VITE_API_URL should point at the server, e.g. http://localhost:4000
npm install
npm run dev
```

Open the printed `localhost:5173` URL. Register two different users in
two browser windows (or one normal + one incognito, since sessions are
per-browser-profile), join the same room from both, and send messages —
each should appear in the other window within one poll interval.

## Stack

Node.js, TypeScript, Express, Postgres, React 19 + Vite + React Router.
No ORM — raw SQL via `pg`, versioned through `node-pg-migrate`. See
`ARCHITECTURE.md` for why.
