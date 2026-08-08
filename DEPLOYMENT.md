# Deploying to Railway

Three Railway services in one project: Postgres (Railway's own plugin),
the API (`server/`), and the static frontend (`client/`). Free-tier/trial
credit is enough for a portfolio project — check Railway's current pricing
before you commit to anything paid.

Do this in order. The order matters — steps 3 and 5 depend on URLs that
don't exist until the service before them is deployed.

## 1. Push this repo to GitHub

Railway deploys from a GitHub repo. If you haven't already:

```bash
cd "/Users/krishnavarma/100x Sch/v26/Chat App"
git push origin master
```

## 2. Create the Railway project + Postgres

In the Railway dashboard: **New Project** → **Provision PostgreSQL**.
That's it for this step — Railway gives this service its own
`DATABASE_URL`, which you'll reference (not retype) in step 3.

## 3. Deploy the server

**New Service** → **Deploy from GitHub repo** → pick this repo.

In the service's **Settings**:
- **Root Directory**: `server`
- Railway should auto-detect `server/railway.json` (build command
  `npm run build`, start command `npm run start`, health check `/health`).
  **If you set the config file path explicitly (via API/CLI instead of the
  dashboard's auto-detect), it must be the path from the repo root —
  `/server/railway.json` — not `railway.json`.** Root Directory and
  Railway Config File are two independent settings; the config file path
  does NOT get prefixed with Root Directory. Getting this wrong produces
  "service config at 'railway.json' not found" and the build never gets
  past initialization — no build logs at all, which makes it look like a
  builder problem when it's actually a path problem. (Confirmed against
  Railway's own docs: docs.railway.com/builds/build-configuration#set-the-root-directory.)

In the service's **Variables**, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Reference the Postgres service's `DATABASE_URL` (Railway's variable-reference picker, not a typed-in value — this is what lets the two services share credentials without you copying a connection string by hand). |
| `JWT_SECRET` | Generate one locally: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` — paste the output. Never reuse the dev value in `.env.example`. |
| `NODE_ENV` | `production` |
| `ACCESS_TOKEN_TTL` | `15m` |
| `CORS_ORIGIN` | Leave as `http://localhost:5173` for now — you'll come back and fix this in step 5, once the client's real URL exists. |

`PORT` doesn't need to be set — Railway injects it automatically, and
`env.ts` already reads `process.env.PORT`.

Deploy. Once it's live, copy its public URL (Settings → Networking →
**Generate Domain** if one isn't already assigned) — you'll need it in
step 4. Migrations run automatically on every boot (`npm run start` is
`migrate:up:prod && node dist/index.js` — `node-pg-migrate` is
idempotent, so this is safe to run on every deploy, not just the first).

## 4. Deploy the client

**New Service** → **Deploy from GitHub repo** → same repo again.

In **Settings**: **Root Directory**: `client`.

In **Variables**, add:

| Variable | Value |
|---|---|
| `VITE_API_URL` | The server's public URL from step 3 (e.g. `https://chat-app-server-production.up.railway.app`). |

**This has to be set before the build runs, not after.** Vite bakes
`import.meta.env.VITE_API_URL` into the compiled JS at build time — it is
NOT read at runtime like a normal Node env var. If you deploy the client
first and add this variable afterward, the build already happened without
it; you'd need to trigger a fresh deploy for it to take effect. Setting it
before the first deploy avoids that entirely.

Deploy, then copy the client's public URL too.

## 5. Close the loop: fix CORS_ORIGIN on the server

Go back to the **server** service's Variables and set:

```
CORS_ORIGIN=<the client's public URL from step 4>
```

This is the chicken-and-egg the two steps above set up on purpose: the
client needs the server's URL to build correctly, and the server needs
the client's URL to accept its requests — neither exists until the other
service has already been deployed once. Updating this variable triggers a
redeploy (fast — it's just an env var, not a rebuild) and the loop is
closed.

## 6. Smoke test

Same test as local dev, just against the real URLs: open the client's
public URL in two browser windows (or one normal + one incognito),
register two different users, join the same room, send a message from
one — it should appear in the other within one poll interval. Refresh a
tab — you should stay logged in (silent refresh working), not get bounced
to `/login`.

If refresh/silent-login specifically is broken in production but worked
locally, the most likely cause is the `SameSite` cookie setting — see the
comment in `server/src/auth/refresh-cookie.ts` for why it has to differ
between `development` and `production` (this was caught and fixed before
this guide was written, specifically because the client and API sit on
different Railway subdomains, which is a genuinely different
cross-site/same-site situation than two `localhost` ports in dev).

## Rolling back

Railway keeps prior deployments — the dashboard's **Deployments** tab has
a one-click **Redeploy** on any earlier build if a new deploy breaks
something.
