# Deploying to Render

URLs:
- API: https://chat-app-server-j0mr.onrender.com
- Client: https://chat-app-client-j5j9.onrender.com

Three pieces, defined together in `render.yaml` at the repo root as a
Render **Blueprint**: a Postgres database, the API (`server/`) as a web
service, and the static frontend (`client/`) as a static site. The free tier
is enough for a portfolio project, with real limits worth knowing up front
(they have each bitten this project):

| Free-tier limit | What it does to you |
|---|---|
| Web service spins down after 15 minutes without inbound traffic | The next request cold-starts in about a minute. HTTP requests **and WebSocket messages from existing connections** count as traffic — so an open chat tab (whose heartbeat replies are WebSocket messages) keeps the service awake, and spends the 750 free instance-hours/month. One always-awake service just fits in a month; two would not. |
| **Free Postgres expires 30 days after creation** | After expiry the database is inaccessible; after a further 14-day grace period it is **deleted with all its data**. See [the database-expiry section](#the-free-database-expires-read-this) — this is the most likely reason a long-idle deployment is down. |
| Only one free Postgres per workspace; no backups | Don't keep anything in it you can't recreate. |
| Render may restart a free service at any time | Every restart is a `SIGTERM` — which is why graceful shutdown (below) is not optional polish. |

## 1. Push this repo to GitHub

Render deploys from a GitHub repo.

```bash
cd "/Users/krishnavarma/100x Sch/v26/Chat App"
git push origin master
```

## 2. Deploy the Blueprint

Render dashboard → **New** → **Blueprint** → pick this repo → branch
`master` → Blueprint Path defaults to `render.yaml` at the repo root
(that's where it lives here, so leave it).

Render reads the file and shows you the three resources it's about to
create (database, web service, static site) plus any variables marked
`sync: false` in the file — it'll prompt for `CORS_ORIGIN` and
`VITE_API_URL` right there, since neither URL exists yet at this point.
Put in placeholders (e.g. `http://localhost:5173` for `CORS_ORIGIN`) —
you'll fix both for real in step 4, same chicken-and-egg as any
two-service deploy where each side needs the other's URL.

Click **Deploy Blueprint**.

## 3. If the server's build fails with a `Cannot find module 'express'` error

This bit us on the first real attempt, so it's worth documenting rather
than rediscovering: `render.yaml` sets `NODE_ENV=production` on the
server, and npm treats that as a signal to skip `devDependencies` during
install — which is exactly where `typescript` and `@types/express` live.
`tsc` still runs (so you get real compile errors, not a "command not
found"), but half the type information is missing, cascading into a wall
of `TS7006`/`TS2339` errors that all trace back to one root cause: express
types never got installed.

Fix (already applied in this repo's `render.yaml`): the server's
`buildCommand` is `npm install --include=dev && npm run build`, which
forces the dev-only, build-time-only packages in regardless of
`NODE_ENV`. If you ever see this exact error shape again — one
`Cannot find module 'X' or its corresponding type declarations'` plus a
cascade of unrelated-looking implicit-`any` errors in the same build —
check this first before assuming the code is broken.

## 4. Fix the two placeholder URLs

Once the server's deployed, copy its real `.onrender.com` URL (Render
appends a random suffix — don't assume it matches the service name
exactly, confirm it from the service's own page).

- **Client** → **Environment** → set `VITE_API_URL` to the server's real
  URL → save. This forces a rebuild, which is required: Vite bakes
  `import.meta.env.VITE_API_URL` into the compiled JS at **build** time,
  not read at runtime like a normal Node env var. Setting this after an
  earlier build already ran means that build shipped without it — always
  needs a fresh rebuild to take effect, not just a variable update. (The
  Socket.IO connection uses this same URL.)
- **Server** → **Environment** → set `CORS_ORIGIN` to the client's real
  URL → save. This one's just an env var + restart, no rebuild needed. It
  must be the one exact origin (scheme + host, no trailing slash): it gates
  both the REST API and the Socket.IO handshake, and the refresh cookie only
  works with an exact, credentialed origin.

## WebSockets on Render

There is nothing to enable: Render's proxy supports WebSockets on every web
service, with no maximum connection duration. What matters is how the app
uses them:

- **Use the `https://` API URL.** Socket.IO upgrades it to `wss://`
  (encrypted) on its own. Never point the client at `http://` in production.
- **The upgrade is the new risk.** Socket.IO starts every connection on HTTP
  long-polling and *upgrades* to a WebSocket. A proxy that doesn't forward the
  `Upgrade` header leaves the app silently stuck on polling: it "works", just
  slower and chattier, and nothing logs an error. Only a test against the real
  deployment can see this — that is what `npm run smoke:live` checks (below).
- **Single instance only.** Presence and room fan-out live in one process's
  memory (ARCHITECTURE_V2 §12). Free services can't scale past one instance
  anyway. If you ever pay for a second: add the Redis adapter, **and** make the
  routing sticky (or switch the client to `transports: ['websocket']`) —
  Engine.IO keeps each session in one process's memory, so a polling session
  or the upgrade request that lands on the other instance gets
  `400 "Session ID unknown"` (`realtime.multiinstance` reproduces it). If you
  front the API with your own nginx, `proxy_read_timeout` must exceed 45 s
  (ping interval + timeout) or idle connections are cut with `transport close`.
- **Heartbeat:** the server pings every 25s and drops a connection that
  doesn't answer within 20s (`SOCKET_PING_INTERVAL_MS` /
  `SOCKET_PING_TIMEOUT_MS`), which is also what keeps an idle connection from
  being closed by an intermediate proxy.

## Graceful shutdown (every deploy and every restart)

Render stops an instance with `SIGTERM`, waits up to 30 seconds
(configurable), then `SIGKILL`s it. On a deploy, traffic shifts to the new
instance first and the old one is told to stop afterwards. The server handles
`SIGTERM` (ARCHITECTURE_V2 §14): it flips `/health` to `503`, tells every
connected client `server_shutdown` (so they reconnect immediately instead of
waiting out a backoff), closes the sockets and the HTTP listener, ends the
database pool, and exits `0` — with a hard 10-second ceiling so it always
finishes before the platform's 30.

Two things have to be true for that to work, and both are easy to break:

1. **`SIGTERM` must reach the Node process.** Signals go only to the direct
   child. `npm run start` is `npm run migrate:up:prod && exec node
   dist/index.js` — the **`exec`** replaces the shell with `node`, so node is
   npm's direct child and receives the signal. Without it, the shell stays in
   between, swallows `SIGTERM`, and the process is simply `SIGKILL`ed 30
   seconds later with every client left to discover the outage on its own.
   `npm run test:signals` proves this locally.
2. **Migrations run in `startCommand`, not a pre-deploy step**, because
   `preDeployCommand` isn't available on the free plan. That means every
   (re)start runs `migrate:up:prod` first; if the database is unreachable the
   service never starts (below).

To see it work for real on the platform, run the deploy watcher, then trigger
a deploy (push a commit, or **Manual Deploy** in the dashboard):

```bash
cd server && npm run smoke:live -- https://chat-app-server-j0mr.onrender.com --watch-deploy
```

You should see `server_shutdown RECEIVED`, a disconnect, and a reconnect
within about a second. In the old instance's logs (Render → service → Logs)
look for `shutdown initiated`, then `database pool closed`.

## The free database expires. Read this.

Free Render Postgres **expires 30 days after creation**, then deletes itself
14 days after that. When it goes, the API can't start: `startCommand` runs
migrations first, and they fail with

```
could not connect to postgres: Error: getaddrinfo ENOTFOUND dpg-xxxxxxxx-a
```

— and every deploy ends `update_failed`, with Render retrying the crash loop.
(This is how this project's most recent deploys failed, with no code wrong:
the build succeeded, then the start command died because the database host no
longer existed.) If
`/health` times out or a deploy log shows that `ENOTFOUND`, check the
**Postgres** page in the dashboard before debugging code.

To recover (all data in the old database is gone — it had no backups):

1. Dashboard → **New → Postgres** → **Free** (name it `chat-app-db` to match
   `render.yaml`). Wait for it to be **Available**.
2. Copy its **Internal Database URL**.
3. API service → **Environment** → set `DATABASE_URL` to that value → save.
   (Alternatively a Blueprint **Manual Sync** may recreate the missing
   database and re-link it for you — but verify `DATABASE_URL` afterwards
   either way; don't assume.)
4. **Manual Deploy → Deploy latest commit.** `migrate:up:prod` recreates the
   schema on the empty database.
5. Run the smoke test (next section).

To stop this recurring every 30 days, either put a calendar reminder on it, or
move `DATABASE_URL` to a Postgres that doesn't expire (several providers
offer a free tier without one; the app only needs a standard connection
string — check whether the provider requires SSL and, if so, add `?sslmode=require`).
Upgrading the Render database to a paid plan also removes the limit.

## 5. Smoke test

Two checks, in this order.

**Automated, against the deployment.** From `server/`:

```bash
npm run smoke:live -- https://chat-app-server-j0mr.onrender.com
```

It waits out the cold start, makes two throwaway accounts and a room, and
verifies — through Render's real proxy — the polling → WebSocket **upgrade**,
pushed delivery (with end-to-end latency), typing, presence online/offline
(it waits out the real 7-second grace period), idempotent resend, a forced
disconnect followed by an exact catch-up, a user who leaves a room being
cut off immediately, and that a flood gets `rate_limited` without being
disconnected. Exit code `0` and `ALL SMOKE CHECKS PASSED` mean
real-time works in production. If the upgrade line fails, the proxy isn't
passing WebSockets through and the rest of the output is for a degraded mode.

**By hand.** Open the client's public URL in two browser windows (one normal,
one incognito), register two users, join the same room, and send a message
from one — it appears in the other immediately, with typing and presence.
Refresh a tab — you stay logged in (silent refresh working), not bounced to
`/login`.

If refresh/silent-login specifically is broken in production but worked
locally, the most likely cause is the `SameSite` cookie setting — see the
comment in `server/src/auth/refresh-cookie.ts` for why it has to differ
between `development` and `production`. The client and API sit on
different Render subdomains — genuinely cross-site — which is a different
situation from two `localhost` ports in dev, where `SameSite=Strict` still
works because same-site only cares about registrable domain, not port.

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| Deploy `update_failed`; logs: `getaddrinfo ENOTFOUND dpg-…` | Free database expired/deleted | [Recovery steps](#the-free-database-expires-read-this) |
| Browser console: `connect_error` / CORS on the socket | `CORS_ORIGIN` isn't the client's exact origin | Server env var; no trailing slash |
| Chat works but feels slow; smoke test says "STILL on long-polling" | Proxy not forwarding `Upgrade` | `npm run smoke:live`; check for a CDN/proxy in front of the API |
| First request after a while takes ~a minute | Free-tier cold start | Expected |
| Every client shows "reconnecting" for ~30s on each deploy, no `shutdown initiated` in the old logs | `SIGTERM` isn't reaching node | `start` script must use `exec node …`; `npm run test:signals` |
| `connect_error: UNAUTHORIZED` right after login | Access token expired or `JWT_SECRET` changed between instances | Server env; a fresh login fixes the former |
| Messages stop arriving for one user only | Their token expired and reauth failed (refresh cookie blocked) | Browser cookies; the `SameSite` note above |

## Rolling back

Render keeps prior deploys — each service's **Events** tab has a
**Rollback** button on any earlier successful deploy if a new one breaks
something. (Free services keep the two most recent.) Rolling back code does
not roll back the database: migrations here are forward-only, so a rollback
across a schema change needs the matching `migrate:down` first.

## Why not Railway

The first attempt at this was on Railway. Its GitHub App connection to
this repo silently broke (`Settings → Source` showed "GitHub Repo not
found") after the services were created via their API — every build died
at initialization regardless of what config was fixed, and neither
Railway's `redeploy` action nor a fresh GitHub push ever triggered a new
build. That's a platform-connection problem, not something fixable from
this repo's side, so the deploy target moved to Render instead of
continuing to fight it.
