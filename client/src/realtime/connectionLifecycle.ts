import type { Socket } from 'socket.io-client';

/**
 * Everything the client does to keep ONE long-lived socket alive across the
 * things that would otherwise end it: credential expiry, a planned server
 * restart, a stale token on reconnect, and a server telling it to slow
 * down. Phase 15 — ARCHITECTURE_V2.md §4, §11, §14.
 *
 * Framework-free and dependency-injected, same move as outbox.ts (Phase 11)
 * and typingTracker.ts (Phase 14): nothing in here imports React, the token
 * store, or the real socket module — it takes a Socket and a few functions.
 * That makes every branch drivable from a fake socket with fake timers
 * (connectionLifecycle.test.ts), and it is also the reason the server-side
 * E2E scripts can run THIS file, unmodified, against a real server instead
 * of a re-implementation that could drift from what actually ships.
 *
 * Returns a detach function that removes every listener and cancels every
 * timer, so a socket that is torn down (logout) leaves nothing behind.
 */

/** See api/client.ts: ok / dead (401, session over) / transient (5xx, network). */
export type RefreshOutcome = 'ok' | 'dead' | 'transient';

export interface LifecycleDeps {
  /** Single-flight token refresh (api/client.ts). Resolves false when the
   * session is gone for good (cookie missing/revoked) — in which case the
   * app's own auth layer logs the user out and this module just stops. */
  refreshAccessToken: () => Promise<boolean>;
  /** Preferred over `refreshAccessToken` when provided: distinguishes a dead
   * session from a hiccup, so a transient failure is RETRIED (within the
   * time left on the current token) instead of being treated as the end. */
  refreshAccessTokenDetailed?: () => Promise<RefreshOutcome>;
  /** The server refused `reauth` because the fresh token belongs to a
   * DIFFERENT user than this socket was opened for (e.g. another tab logged
   * in as someone else and the shared refresh cookie now mints their
   * tokens). The socket is closed and is deliberately NOT reconnected: doing
   * so would silently continue as the other user under the old user's UI.
   * The app should reset (reload / log out). */
  onIdentityChanged?: () => void;
  getAccessToken: () => string | null;
  /** Re-sends everything still queued in the outbox (outbox.ts). */
  flushOutbox: () => void;
}

export interface LifecycleOptions {
  /** Upper bound of a random delay before refreshing in response to
   * `token_expiring`. Default 1500ms. See onTokenExpiring. */
  reauthJitterMaxMs?: number;
  /** How long to wait for the server to answer `reauth`. Default 5000ms. */
  reauthAckTimeoutMs?: number;
  /** How long a `server_shutdown` notice stays "live". Default 30s. */
  shutdownNoticeTtlMs?: number;
  /** Consecutive UNAUTHORIZED handshake rejections to recover from before
   * giving up. Default 3. */
  maxAuthRetries?: number;
  /** First wait before retrying a transient refresh failure; doubles each
   * time (500, 1000, 2000, ...), jittered. Default 500ms. */
  refreshRetryBaseMs?: number;
  /** Stop retrying this long before the token's expiry, leaving time for the
   * reauth itself. Default 1000ms. */
  refreshRetryMarginMs?: number;
  random?: () => number;
  now?: () => number;
}

export function attachConnectionLifecycle(socket: Socket, deps: LifecycleDeps, options: LifecycleOptions = {}): () => void {
  const reauthJitterMaxMs = options.reauthJitterMaxMs ?? 1500;
  const reauthAckTimeoutMs = options.reauthAckTimeoutMs ?? 5000;
  const shutdownNoticeTtlMs = options.shutdownNoticeTtlMs ?? 30_000;
  const maxAuthRetries = options.maxAuthRetries ?? 3;
  const refreshRetryBaseMs = options.refreshRetryBaseMs ?? 500;
  const refreshRetryMarginMs = options.refreshRetryMarginMs ?? 1000;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  let detached = false;
  let shutdownNoticedAt: number | null = null;
  let tokenExpiredNotice = false;
  let reauthInFlight = false;
  let authRetries = 0;
  let rateLimitRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        pendingTimers.delete(t);
        resolve();
      }, ms);
      pendingTimers.add(t);
    });
  }

  async function refresh(): Promise<RefreshOutcome> {
    if (deps.refreshAccessTokenDetailed) return deps.refreshAccessTokenDetailed();
    return (await deps.refreshAccessToken()) ? 'ok' : 'dead';
  }

  // ---------------------------------------------------------------- §14
  // `server_shutdown` — the server is about to close every connection on
  // purpose (a deploy). The ack matters: the server holds the door open
  // until every client has confirmed it heard (bounded by a timeout), so
  // closing doesn't race the notice.
  function onServerShutdown(ack?: () => void): void {
    shutdownNoticedAt = now();
    if (typeof ack === 'function') ack();
  }

  /**
   * The next disconnect after a shutdown notice is expected, not a failure,
   * so skip the backoff for the FIRST retry only.
   *
   * Why not just set reconnectionDelay(0) and leave it: Socket.IO's backoff
   * is `delay * 2^attempts`, and 0 * anything is 0 — leaving it at zero
   * would turn "server is restarting" into a hot loop of connection
   * attempts against a port nobody is listening on yet. So: zero for the
   * first attempt, then restore the configured delay the instant that
   * attempt starts ('reconnect_attempt' fires as the attempt begins), after
   * which ordinary exponential backoff with jitter takes over.
   *
   * This is only safe to do from inside the 'disconnect' listener because
   * of an ordering guarantee in the client's Manager: it emits 'close'
   * (which is what produces the Socket's 'disconnect') BEFORE it calls
   * reconnect() to compute the delay — so a change made here is seen by
   * the very reconnect it is meant to affect. The E2E script measures this
   * for real rather than trusting that reading of the library.
   */
  function reconnectWithoutBackoff(): void {
    const manager = socket.io;
    const configuredDelay = manager.reconnectionDelay();
    manager.reconnectionDelay(0);
    manager.once('reconnect_attempt', () => manager.reconnectionDelay(configuredDelay));
  }

  // ---------------------------------------------------------------- §4
  /**
   * `token_expiring`: refresh over HTTP, then swap the credential on THIS
   * socket without dropping it.
   *
   * The jitter is a mitigation, not a fix, for a race that is real: the
   * refresh token ROTATES (Phase 2), so two refreshes presenting the same
   * cookie at the same instant look like token reuse to the server, which
   * revokes the whole family and logs the user out everywhere. Within one
   * tab, api/client.ts's single-flight refresh already prevents it. Across
   * TABS it doesn't — each tab has its own JS context, but they share one
   * cookie — and two tabs that connected at similar moments have similar
   * token expiry. A small random delay makes it unlikely they refresh in
   * the same few milliseconds. The gap itself is closed one layer down:
   * api/client.ts wraps the refresh in a cross-tab Web Lock, so the second
   * tab's request only goes out after the first has rotated the cookie.
   */
  function onTokenExpiring(payload?: { expiresInMs?: number }): void {
    if (reauthInFlight) return; // a second warning while one is being handled adds nothing
    reauthInFlight = true;
    void reauthenticate(payload?.expiresInMs).finally(() => {
      reauthInFlight = false;
    });
  }

  async function reauthenticate(expiresInMs?: number): Promise<void> {
    // The warning says how long this token has left. That is the whole
    // budget for getting a new one: retrying past it is pointless, the
    // server will have closed us by then (and the "token_expired" path
    // below picks up from there).
    const deadline = now() + (expiresInMs ?? 10_000);

    await sleep(random() * reauthJitterMaxMs);
    if (detached) return;

    // Refresh, retrying TRANSIENT failures (5xx, network) with jittered
    // exponential backoff for as long as the token has time left. A DEAD
    // session (401) is not retried — nothing will fix it.
    for (let attempt = 0; ; attempt++) {
      const outcome = await refresh();
      if (detached) return;
      if (outcome === 'ok') break;
      if (outcome === 'dead') return; // session gone: the auth layer handles logout

      const wait = refreshRetryBaseMs * 2 ** attempt * (0.5 + random() / 2);
      if (now() + wait >= deadline - refreshRetryMarginMs) return; // out of time
      await sleep(wait);
      if (detached) return;
    }

    const token = deps.getAccessToken();
    if (!token) return;

    const result = await emitReauth(token);
    if (detached || result?.ok) return;

    // A valid token for a DIFFERENT user. The server has already closed this
    // socket; reconnecting would just reopen it as that other user.
    if (result?.code === 'FORBIDDEN') {
      deps.onIdentityChanged?.();
      return;
    }

    // The in-place swap failed (timed out, or the server refused it).
    // Fall back to the blunt instrument that always works: a clean
    // disconnect/connect, which picks up the fresh token through the
    // socket's `auth` callback and recovers any gap via Phase 12's catch-up.
    socket.disconnect();
    socket.connect();
  }

  function emitReauth(token: string): Promise<{ ok: boolean; code?: string } | null> {
    return new Promise((resolve) => {
      socket.timeout(reauthAckTimeoutMs).emit('reauth', { token }, (err: Error | null, result: { ok: boolean; code?: string }) => {
        resolve(err ? null : result);
      });
    });
  }

  // The server's last words before force-closing for an expired token.
  function onDisconnectReason(payload: { reason?: string } | undefined): void {
    if (payload?.reason === 'token_expired') tokenExpiredNotice = true;
  }

  async function refreshThenConnect(): Promise<void> {
    const refreshed = await deps.refreshAccessToken();
    if (detached || !refreshed) return;
    socket.connect();
  }

  function onDisconnect(reason: string): void {
    const serverClosedUs = reason === 'io server disconnect';

    // Server said "token expired" and hung up. Socket.IO does NOT retry a
    // server-initiated disconnect by itself, and retrying with the same
    // dead token would just be rejected again — refresh first, then connect.
    if (tokenExpiredNotice) {
      tokenExpiredNotice = false;
      if (serverClosedUs) void refreshThenConnect();
      return;
    }

    // Planned restart (§14).
    if (shutdownNoticedAt !== null) {
      const fresh = now() - shutdownNoticedAt <= shutdownNoticeTtlMs;
      shutdownNoticedAt = null;
      if (fresh) {
        if (serverClosedUs) socket.connect();
        else reconnectWithoutBackoff();
      }
    }
  }

  // A reconnect (e.g. after the laptop slept past the token's lifetime)
  // presents whatever token is in memory, which may be long dead. The
  // server rejects that handshake in middleware, and Socket.IO does NOT
  // auto-retry a middleware rejection — so without this the socket would
  // just stay down, silently, until something else happened to refresh.
  // Capped so a refresh that "succeeds" but still yields a rejected token
  // can't loop forever.
  function onConnectError(err: Error): void {
    if (err?.message !== 'UNAUTHORIZED') return;
    if (authRetries >= maxAuthRetries) return;
    authRetries += 1;
    void (async () => {
      const refreshed = await deps.refreshAccessToken();
      if (detached || !refreshed) return;
      socket.connect();
    })();
  }

  function onConnect(): void {
    authRetries = 0;
  }

  // ---------------------------------------------------------------- §11
  /**
   * `rate_limited` for send_message: the refused message is still sitting
   * in the outbox (a refusal isn't a definitive failure), so schedule one
   * flush for just after the advertised delay. One pending timer is enough:
   * flushing re-sends everything queued, so more notices arriving while
   * it's pending change nothing. The extra 100ms is slack for the bucket to
   * actually have a token when the retry lands rather than racing it.
   *
   * typing_* notices need no handling — typing is ephemeral; a dropped
   * indicator isn't worth retrying.
   */
  function onRateLimited(payload: { event?: string; retryAfterSeconds?: number } | undefined): void {
    if (payload?.event !== 'send_message') return;
    if (rateLimitRetryTimer) return;
    const delayMs = Math.max(1, payload.retryAfterSeconds ?? 1) * 1000 + 100;
    rateLimitRetryTimer = setTimeout(() => {
      rateLimitRetryTimer = undefined;
      deps.flushOutbox();
    }, delayMs);
  }

  socket.on('server_shutdown', onServerShutdown);
  socket.on('token_expiring', onTokenExpiring);
  socket.on('disconnect_reason', onDisconnectReason);
  socket.on('disconnect', onDisconnect);
  socket.on('connect_error', onConnectError);
  socket.on('connect', onConnect);
  socket.on('rate_limited', onRateLimited);

  return function detach(): void {
    detached = true;
    socket.off('server_shutdown', onServerShutdown);
    socket.off('token_expiring', onTokenExpiring);
    socket.off('disconnect_reason', onDisconnectReason);
    socket.off('disconnect', onDisconnect);
    socket.off('connect_error', onConnectError);
    socket.off('connect', onConnect);
    socket.off('rate_limited', onRateLimited);
    if (rateLimitRetryTimer) clearTimeout(rateLimitRetryTimer);
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
  };
}
