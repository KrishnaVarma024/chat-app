import { getAccessToken, setAccessToken } from './tokenStore';

export const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Single-flight refresh. If several requests hit a 401 at nearly the same
// moment (e.g. the room list and the message poll both fire right as the
// access token expires), only the FIRST one actually calls /auth/refresh;
// every other 401 just awaits this same promise instead of firing its own
// refresh. This is the client-side half of a race we found and stress-
// tested server-side in Phase 2 (refresh-race-test.mjs): two genuinely
// concurrent /auth/refresh calls presenting the same token, where the
// loser's family-wide reuse-revocation can collaterally kill the winner's
// brand-new token microseconds after it was issued. Deduping here means
// normal UI usage essentially never fires that race in the first place —
// a page with N simultaneous requests triggers at most ONE refresh, not N.
let refreshPromise: Promise<RefreshOutcome> | null = null;

/**
 * What a refresh attempt tells the caller. A boolean can't carry the
 * distinction that matters most to a long-lived socket:
 *   ok        — new access token stored.
 *   dead      — the server said 401/403: the refresh cookie is missing,
 *               expired, revoked or reused. The session is over.
 *   transient — a 5xx, a 429, or no response at all. NOTHING is known to be
 *               wrong with the session, and the access token in memory is
 *               still good until its own `exp`, so it is left in place and
 *               the caller may try again.
 * The old boolean conflated the last two and cleared the token on both.
 */
export type RefreshOutcome = 'ok' | 'dead' | 'transient';

const REFRESH_LOCK_NAME = 'chat-app-refresh';

/**
 * The refresh token ROTATES (Phase 2), and every tab shares one cookie jar
 * but has its own JS memory — so the in-tab single-flight above does nothing
 * for two TABS refreshing at the same instant: both send the same cookie, the
 * second looks like token reuse, and the server revokes the whole family
 * (everyone gets logged out). The Web Locks API gives mutual exclusion across
 * every tab of an origin: while one tab holds the lock the others queue, and
 * by the time they run, the cookie jar already holds the rotated token.
 * Browsers without it (very old ones, and jsdom) just run unlocked, which is
 * exactly the previous behavior.
 */
async function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(REFRESH_LOCK_NAME, fn) : fn();
}

async function refreshAccessTokenOutcome(): Promise<RefreshOutcome> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = withCrossTabLock(async (): Promise<RefreshOutcome> => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include', // sends the httpOnly refresh_token cookie
      });
      if (res.ok) {
        const data: { accessToken: string } = await res.json();
        setAccessToken(data.accessToken);
        return 'ok';
      }
      if (res.status === 401 || res.status === 403) {
        setAccessToken(null);
        return 'dead';
      }
      return 'transient';
    } catch {
      return 'transient';
    }
  }).finally(() => {
    // Cleared unconditionally so the *next* 401 — a genuinely new event
    // that didn't race with this one — gets to trigger its own refresh.
    refreshPromise = null;
  });

  return refreshPromise;
}

/** Boolean view of the above, for callers that only need "do I have a fresh
 * token now?" (apiFetch's retry, app boot). */
async function refreshAccessToken(): Promise<boolean> {
  return (await refreshAccessTokenOutcome()) === 'ok';
}

interface RequestOptions extends RequestInit {
  /** Internal — prevents the retried request from retrying itself again. */
  _isRetry?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  // Only attempt a silent refresh if we HAD a token — a 401 with no token
  // present just means "not logged in" (e.g. wrong password on /auth/login),
  // not "session expired", and refreshing wouldn't make sense there.
  if (res.status === 401 && !options._isRetry && token) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, _isRetry: true });
    }
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = await res.json();
      message = body?.error?.message ?? message;
      code = body?.error?.code;
    } catch {
      // No JSON body — fall back to the generic message above.
    }
    throw new ApiError(res.status, message, code);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Exposed so the app-boot flow (AuthContext) can attempt a silent refresh
// directly, without a prior failed request to retry — there's nothing to
// retry on first load, just a cookie to try exchanging for a fresh token.
export { refreshAccessToken, refreshAccessTokenOutcome };
