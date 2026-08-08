import type { Response } from 'express';
import { env } from '../config/env';
import { REFRESH_COOKIE_NAME, REFRESH_TOKEN_TTL_MS } from './refresh-tokens';

export function setRefreshCookie(res: Response, rawToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    httpOnly: true, // unreachable from JS — closes the XSS token-theft path
    secure: env.nodeEnv === 'production', // browsers drop Secure cookies over plain http, which local dev is
    // 'strict' in dev, 'none' in production — NOT the same value
    // everywhere, and this is a real pre-deploy catch, not a style choice.
    // Locally, the Vite client (localhost:5173) and API (localhost:4000)
    // are different ORIGINS but the same SITE — SameSite only cares about
    // the registrable domain, not the port, so 'strict' already works in
    // dev and is the more defensive choice there. Deployed, the client and
    // API sit on different Railway subdomains (e.g. *.up.railway.app),
    // which — unlike two localhost ports — ARE cross-site from each
    // other. 'strict' (or even 'lax') would mean the browser silently
    // never attaches this cookie to the deployed client's fetch calls at
    // all, breaking refresh/silent-login in production while every local
    // and sandbox test kept passing, since none of them ever exercised a
    // genuinely cross-site request. 'none' is the standard, correct value
    // for this "SPA on one domain, API on another" shape — it REQUIRES
    // Secure (already true above whenever this branch is reachable, since
    // both flip on the same env.nodeEnv === 'production' check).
    sameSite: env.nodeEnv === 'production' ? 'none' : 'strict',
    maxAge: REFRESH_TOKEN_TTL_MS,
    // Only sent back to /auth/*, not attached to every request the way a
    // root-scoped cookie would be. Refresh/logout are the only routes that
    // need it.
    path: '/auth',
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
}
