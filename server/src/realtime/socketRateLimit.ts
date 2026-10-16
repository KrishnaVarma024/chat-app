import type { Socket } from 'socket.io';
import type { BucketStore } from '../rateLimit/bucketStore';
import { logger } from '../observability/logger';
import type { AuthedSocketData } from './socketAuth.middleware';

/** What a socket is told when one of its events is refused. */
export interface RateLimitedPayload {
  event: string;
  retryAfterSeconds: number;
}

/**
 * Socket events have no middleware chain to hang a limiter on (v1's was
 * Express middleware), so this is called explicitly, as the FIRST line of
 * each handler that needs one — ARCHITECTURE_V2.md §11.
 *
 * Returns true if the event may proceed. On refusal it emits a
 * `rate_limited` event to THIS socket and returns false; it never
 * disconnects anyone. A rate limit is "slow down," not "get out": dropping
 * a persistent connection over a transient burst costs a full
 * reconnect-and-catch-up cycle, which is far more disruptive than v1's
 * "reject one HTTP request, the next one succeeds."
 *
 * Why it runs BEFORE validation and the DB membership check, not after:
 * a refused event should cost as close to nothing as possible. If an
 * invalid payload got an `error` reply for free, a flood of garbage would
 * turn this server into an amplifier (one cheap event in, one reply out,
 * unlimited). Charging a token first caps garbage floods too.
 *
 * Keyed by userId, not socket.id: abuse potential scales with how many
 * connections an attacker opens, so a per-connection budget would hand
 * every extra tab its own free allowance (same lesson as presence's
 * reference counting, Phase 13).
 *
 * Notices are themselves rate limited. Without that, a client flooding
 * 1,000 events/sec would earn ~1,000 `rate_limited` replies/sec — the
 * limiter would be amplifying the very flood it exists to stop. Instead
 * each (socket, event) pair gets at most one notice per `retryAfterSeconds`
 * window, which is also exactly how long the client was told to wait, so
 * a well-behaved client never needs a second one. The same throttle bounds
 * the log line below (a warn per refused event would let an attacker fill
 * the disk).
 *
 * A notice describes the socket's BUDGET, not any single event's fate —
 * that is why it carries no clientMessageId. A refused send_message is not
 * a definitive failure (unlike a VALIDATION_ERROR): it stays in the
 * client's outbox and is retried after `retryAfterSeconds`; the server
 * stays idempotent either way (Phase 4).
 */
export function enforceSocketRateLimit(socket: Socket, store: BucketStore, event: string): boolean {
  const data = socket.data as AuthedSocketData;
  const result = store.consume(data.userId);
  if (result.allowed) return true;

  const now = Date.now();
  const noticeUntil = (data.rateLimitNoticeUntil ??= {});
  if (now >= (noticeUntil[event] ?? 0)) {
    noticeUntil[event] = now + result.retryAfterSeconds * 1000;
    const payload: RateLimitedPayload = { event, retryAfterSeconds: result.retryAfterSeconds };
    socket.emit('rate_limited', payload);
    logger.warn('socket event rate limited', {
      userId: data.userId,
      socketId: socket.id,
      event,
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
  return false;
}
