// The access token lives here — a plain module-level variable, not React
// state and never localStorage/sessionStorage. Per ARCHITECTURE.md §5, the
// point of keeping it in memory only is reducing XSS blast radius: a
// script injected into the page can still read it (nothing in-memory is
// safe from a same-origin XSS), but it can't survive a page reload or be
// read by a completely separate script that only has localStorage access,
// and it's never written to disk. The real payoff of "in memory only" is
// what it *forces*: no session survives a refresh without the app
// re-proving itself via the httpOnly refresh cookie, which JS can't touch
// at all.
//
// Why a module singleton instead of just React Context? Because
// api/client.ts (plain functions, not components) needs to read and write
// this token too — during a silent refresh triggered by a 401, deep inside
// a fetch call, with no component instance in scope. Threading that through
// React Context from inside a non-component module isn't possible, so the
// token's single source of truth lives here, and AuthContext subscribes to
// it via onAccessTokenChange to stay in sync for rendering.

let accessToken: string | null = null;

type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const listener of listeners) listener(token);
}

export function onAccessTokenChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
