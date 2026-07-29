# Roadmap

Build order for the chat app described in `ARCHITECTURE.md`. Each phase has
a hands-on deliverable and a concrete definition of done — no phase is
"done" until its DoD passes, not until the code merely exists.

## Phase 0 — Foundations & Schema
**Build:** repo skeleton (git, `.gitignore`, `package.json`, `tsconfig.json`),
Postgres via Docker Compose, all migrations from `ARCHITECTURE.md` §4, a
seed script (2 users, 1 room, membership row).
**Done when:** `docker compose up` + migrations run clean; `psql` shows all
six tables; seed script is idempotent (safe to re-run).

## Phase 1 — Auth: Register & Login (access token only)
**Build:** `POST /auth/register`, `POST /auth/login`, password hashing,
JWT issuance, auth middleware that verifies the token and attaches
`req.user`.
**Done when:** can register, log in, hit a protected `GET /me` with the
token and get your profile, get 401 without it or with a tampered token.

## Phase 2 — Refresh Token Rotation & Reuse Detection
**Build:** `refresh_tokens` wiring, `POST /auth/refresh`, `POST
/auth/logout`, httpOnly cookie handling for the refresh token.
**Done when:** refreshing issues a new pair and revokes the old token;
replaying an already-used refresh token revokes the entire family;
subsequent refresh attempts with any token from that family fail even if
they were never individually used.

## Phase 3 — Rooms & Membership
**Build:** create room, join, leave, list my rooms, membership-gated
authorization middleware.
**Done when:** a user who hasn't joined a room gets 403 on read and write
for that room; a member gets 200.

## Phase 4 — Messages: Atomic Sequencing + Idempotent Send
**Build:** `POST /rooms/:id/messages` implementing the counter-row
UPSERT + insert transaction from `ARCHITECTURE.md` §6.
**Done when:** a script that fires 50 concurrent sends into one room
produces sequence numbers 1–50 with zero gaps and zero duplicates;
resending the same `client_message_id` returns the original message
instead of creating a second one.

## Phase 5 — Cursor Pagination + Poll/Sync Endpoint
**Build:** `GET /rooms/:id/messages?after=<cursor>` (poll) and
`?before=<cursor>` (scrollback), opaque cursor encode/decode, `has_more`
and `latest_sequence_number` in the poll response.
**Done when:** scrolling back through history while new messages are
being inserted concurrently produces no duplicate or skipped rows; the
poll endpoint returns exactly the messages after a given cursor, no more,
no less.

## Phase 6 — React Frontend
**Build:** login/register screens with silent-refresh-on-401, room list,
chat view, the polling hook (interval + Page Visibility pause + backoff
when idle), infinite scroll upward using Phase 5's cursor, optimistic
send keyed by a client-generated UUID.
**Done when:** two browser sessions as different users in the same room
see each other's messages within one poll interval; a message sent while
offline appears once reconnected, exactly once.

## Phase 7 — Hardening
**Build:** per-user token-bucket rate limiting on send + poll, request-id
propagation through logs, centralized error handler with a consistent
error shape, input validation.
**Done when:** exceeding the rate limit returns 429; every log line for a
single request shares one request id; malformed input returns a 4xx with
a structured error body, never a 500.

## Phase 8 — Tests, Docs, Deploy
**Build:** integration tests for the three load-bearing scenarios (reuse
detection, concurrent sequence integrity, pagination stability under
concurrent insert), finalized docs, deployed API + Postgres + frontend.
**Done when:** all tests pass in one command; the app is reachable at a
public URL.

---

**Workflow:** after each phase's DoD passes, review happens in chat —
phase-specific questions based on the actual implementation, framed the
way a senior would probe it in a code review. Only the phase's source
code gets committed and pushed to GitHub.
