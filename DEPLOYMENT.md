# Deploying to Render

Live URLs (as of this deploy):
- API: https://chat-app-server-j0mr.onrender.com
- Client: https://chat-app-client-j5j9.onrender.com

Three pieces, defined together in `render.yaml` at the repo root as a
Render **Blueprint**: a Postgres database, the API (`server/`) as a web
service, and the static frontend (`client/`) as a static site. Free tier
is enough for a portfolio project — the web service spins down after 15
minutes idle and cold-starts (~50s) on the next request; fine for a demo,
not for something that needs to always be warm.

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
  needs a fresh rebuild to take effect, not just a variable update.
- **Server** → **Environment** → set `CORS_ORIGIN` to the client's real
  URL → save. This one's just an env var + restart, no rebuild needed.

## 5. Smoke test

Open the client's public URL in two browser windows (or one normal + one
incognito), register two different users, join the same room, send a
message from one — it should appear in the other within one poll
interval. Refresh a tab — you should stay logged in (silent refresh
working), not get bounced to `/login`.

If refresh/silent-login specifically is broken in production but worked
locally, the most likely cause is the `SameSite` cookie setting — see the
comment in `server/src/auth/refresh-cookie.ts` for why it has to differ
between `development` and `production`. The client and API sit on
different Render subdomains — genuinely cross-site — which is a different
situation from two `localhost` ports in dev, where `SameSite=Strict` still
works because same-site only cares about registrable domain, not port.

## Rolling back

Render keeps prior deploys — each service's **Events** tab has a
**Rollback** button on any earlier successful deploy if a new one breaks
something.

## Why not Railway

The first attempt at this was on Railway. Its GitHub App connection to
this repo silently broke (`Settings → Source` showed "GitHub Repo not
found") after the services were created via their API — every build died
at initialization regardless of what config was fixed, and neither
Railway's `redeploy` action nor a fresh GitHub push ever triggered a new
build. That's a platform-connection problem, not something fixable from
this repo's side, so the deploy target moved to Render instead of
continuing to fight it.
