# Chat App

A polling-based chat backend (users, rooms, messages) built around
messaging-delivery correctness rather than CRUD breadth: gap-free
per-room sequence numbers, cursor/keyset pagination, and JWT
refresh-token rotation with reuse detection.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the system design and
[`ROADMAP.md`](./ROADMAP.md) for the build plan.

## Status

Phase 0 complete: database schema and local dev environment.

## Getting Started (server)

```bash
cd server
cp .env.example .env

# start Postgres locally
docker compose up -d

npm install
npm run migrate:up
npm run seed
```

Verify it worked:

```bash
docker compose exec postgres psql -U chatapp -d chatapp -c '\dt'
docker compose exec postgres psql -U chatapp -d chatapp -c 'select * from room_members;'
```

You should see six tables and a `general` room with `alice` (owner) and
`bob` (member).

## Stack

Node.js, TypeScript, Express (from Phase 1), Postgres, React (from Phase
6). No ORM — raw SQL via `pg`, versioned through `node-pg-migrate`. See
`ARCHITECTURE.md` for why.
