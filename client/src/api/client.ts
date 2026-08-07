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
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include', // sends the httpOnly refresh_token cookie
      });
      if (!res.ok) {
        setAccessToken(null);
        return false;
      }
      const data: { accessToken: string } = await res.json();
      setAccessToken(data.accessToken);
      return true;
    } catch {
      setAccessToken(null);
      return false;
    } finally {
      // Cleared unconditionally so the *next* 401 — a genuinely new event
      // that didn't race with this one — gets to trigger its own refresh.
      refreshPromise = null;
    }
  })();

  return refreshPromise;
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
export { refreshAccessToken };
