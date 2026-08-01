import type { Response } from 'express';
import { env } from '../config/env';
import { REFRESH_COOKIE_NAME, REFRESH_TOKEN_TTL_MS } from './refresh-tokens';

export function setRefreshCookie(res: Response, rawToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    httpOnly: true, // unreachable from JS — closes the XSS token-theft path
    secure: env.nodeEnv === 'production', // browsers drop Secure cookies over plain http, which local dev is
    sameSite: 'strict', // never sent on a cross-site request — the CSRF trade this cookie is making
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
