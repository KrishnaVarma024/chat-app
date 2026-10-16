import type { Server, Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/tokens';
import { env } from '../config/env';
import { logger } from '../observability/logger';
import type { AuthedSocketData } from './socketAuth.middleware';

/** setTimeout stores its delay in a signed 32-bit int; anything larger
 * silently fires after 1ms (Node even prints a warning). An access-token
 * TTL configured in weeks would otherwise make every socket "expire"
 * instantly. Clamping just means the timer fires early and re-arms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function clampDelay(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_TIMER_MS);
}

export interface ReauthResult {
  ok: boolean;
  /** Present on success: how long the NEW token is good for, so the client
   * can sanity-check that the credential it just sent is the one it meant to. */
  expiresInMs?: number;
  /** Present on failure. UNAUTHORIZED = token invalid/expired; FORBIDDEN =
   * valid token for a DIFFERENT user (the socket is closed). */
  code?: 'UNAUTHORIZED' | 'FORBIDDEN';
}

/**
 * Mid-connection reauthentication — ARCHITECTURE_V2.md §4.
 *
 * A socket can live for hours; the access token it authenticated with lives
 * for minutes. Two ways to reconcile that: drop and reconnect on every
 * token rotation, or swap the credential on the live socket. This does the
 * latter, because tearing down a perfectly healthy connection just to
 * rotate a string is wasted work AND opens a delivery gap (Phase 12's
 * catch-up would paper over it, but "recoverable" is not "free").
 *
 * The lifecycle, per socket:
 *   1. At the handshake, socketAuth.middleware records the token's `exp`.
 *   2. A timer fires `token_expiring` shortly before that moment.
 *   3. The client refreshes over HTTP (cookie-based, unchanged from v1) and
 *      emits `reauth { token }` on the SAME socket.
 *   4. We verify it, move both timers to the new `exp`, and ack.
 *   5. If the client never does, a second timer force-disconnects at `exp`
 *      with `disconnect_reason: token_expired`, so the client knows to
 *      refresh BEFORE reconnecting instead of retrying a dead token forever.
 *
 * Nothing here talks to the database. The refresh endpoint already gates
 * "does this session still exist" (a deleted account or revoked token
 * family cannot obtain a new access token), so the worst a revoked session
 * can do is ride its current access token to its natural expiry — at most
 * one TTL. That bound is the price of stateless JWTs and is the same one
 * every HTTP request already lives with.
 */
export function registerReauthHandlers(_io: Server, socket: Socket): void {
  const data = socket.data as AuthedSocketData;
  let warnTimer: NodeJS.Timeout | undefined;
  let expireTimer: NodeJS.Timeout | undefined;

  function clearTimers(): void {
    if (warnTimer) clearTimeout(warnTimer);
    if (expireTimer) clearTimeout(expireTimer);
    warnTimer = undefined;
    expireTimer = undefined;
  }

  function arm(expiresAtMs: number): void {
    clearTimers();
    data.tokenExpiresAtMs = expiresAtMs;

    const msUntilExpiry = expiresAtMs - Date.now();
    // Warn `lead` before expiry — but never earlier than the midpoint of
    // the token's remaining life. Without that floor, a token whose whole
    // lifetime is shorter than `lead` (a misconfigured TTL, or a socket
    // that connected with a token that was already nearly dead) would be
    // "expiring" the instant it was issued: the client refreshes, gets a
    // fresh short token, is told it's expiring immediately, refreshes
    // again — a hot loop hammering /auth/refresh.
    const lead = Math.min(env.tokenExpiryWarningLeadMs, Math.floor(msUntilExpiry / 2));
    const msUntilWarning = msUntilExpiry - lead;

    warnTimer = setTimeout(() => {
      // Same early-fire hazard as the expiry timer below: a delay clamped to
      // the setTimeout ceiling fires long before the real warning time, and a
      // premature `token_expiring` is a lie. Re-arm instead of emitting.
      if (data.tokenExpiresAtMs - Date.now() - lead > 1_000) {
        arm(data.tokenExpiresAtMs);
        return;
      }
      socket.emit('token_expiring', { expiresInMs: Math.max(0, data.tokenExpiresAtMs - Date.now()) });
    }, clampDelay(msUntilWarning));

    expireTimer = setTimeout(() => {
      // A clamped (very long) timer fires early; if the token really is
      // still valid, just re-arm instead of killing a healthy connection.
      if (data.tokenExpiresAtMs - Date.now() > 1_000) {
        arm(data.tokenExpiresAtMs);
        return;
      }
      logger.info('socket access token expired without reauth — disconnecting', {
        userId: data.userId,
        socketId: socket.id,
      });
      // Emitted BEFORE the disconnect, on the same transport, so it arrives
      // first. Socket.IO's own disconnect reason on the client is just
      // "io server disconnect" — it cannot tell "kicked" from "token ran
      // out." This is what lets the client choose to refresh first.
      socket.emit('disconnect_reason', { reason: 'token_expired' });
      socket.disconnect(true);
    }, clampDelay(msUntilExpiry));
  }

  socket.on('reauth', (payload: { token?: unknown } | undefined, ack?: (result: ReauthResult) => void) => {
    const reply = typeof ack === 'function' ? ack : () => undefined;

    const token = payload?.token;
    if (typeof token !== 'string' || token.length === 0) {
      return reply({ ok: false, code: 'UNAUTHORIZED' });
    }

    let verified;
    try {
      verified = verifyAccessToken(token);
    } catch {
      // Deliberately does NOT disconnect and does NOT touch the timers: the
      // socket's CURRENT credential is still valid until its own `exp`, and
      // a client that sent a bad token (or lost a race with another tab's
      // refresh) can retry. The expiry timer remains the backstop.
      return reply({ ok: false, code: 'UNAUTHORIZED' });
    }

    // The security-critical line. A reauth swaps the credential on a socket
    // that already has identity-bound state: its Socket.IO rooms were
    // admitted for THIS user, its presence entry belongs to THIS user, its
    // sends are attributed to THIS user. Accepting a valid token for a
    // different user would let one account silently inherit another's
    // memberships (or the reverse) — session fixation on a live connection.
    // Identity is fixed at the handshake; reauth may only extend it.
    if (verified.sub !== data.userId) {
      logger.warn('reauth attempted with a token for a different user — disconnecting', {
        userId: data.userId,
        attemptedUserId: verified.sub,
        socketId: socket.id,
      });
      reply({ ok: false, code: 'FORBIDDEN' });
      socket.disconnect(true);
      return;
    }

    arm(verified.exp * 1000);
    reply({ ok: true, expiresInMs: Math.max(0, verified.exp * 1000 - Date.now()) });
  });

  // Without this, a socket that disconnects leaves two live timers pointing
  // at a dead socket — one per connection, forever, over a long-running
  // process. Cheap to forget, expensive to find.
  socket.on('disconnect', clearTimers);

  arm(data.tokenExpiresAtMs);
}
