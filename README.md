# Chat App

A polling-based chat backend (users, rooms, messages) built around
messaging-delivery correctness rather than CRUD breadth: gap-free
per-room sequence numbers, cursor/keyset pagination, and JWT
refresh-token rotation with reuse detection.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the system design and
[`ROADMAP.md`](./ROADMAP.md) for the build plan.

## Status

Phases 0–6 complete: schema, register/login, refresh-token rotation with
reuse detection, rooms & membership, atomic sequenced/idempotent message
send, cursor pagination (poll + scrollback), and the React frontend
(auth, room list, polling chat view, infinite scroll, optimistic send).
Phase 7 (hardening: rate limiting, request-id logging, centralized error
handling, input validation) is next. See `ROADMAP.md` for the full plan
and each phase's definition of done.

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
