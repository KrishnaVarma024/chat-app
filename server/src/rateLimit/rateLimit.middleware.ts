import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../auth/auth.middleware';
import { TokenBucket } from './tokenBucket';
import { RateLimitError } from '../errors';

export interface RateLimiterOptions {
  /** Max burst size — how many requests can fire back-to-back before
   * throttling kicks in. */
  capacity: number;
  /** Sustained rate once the burst is used up. */
  refillPerSecond: number;
  /** Distinguishes independently-limited endpoints (e.g. "send" vs "poll")
   * so a chatty poller can't eat into a user's budget for sending
   * messages, and vice versa — prefix the key so two different limiters
   * never collide in the same bucket store even for the same user id. */
  keyPrefix: string;
}

/**
 * Per-user token-bucket rate limiting, keyed by the authenticated user's id
 * (never by IP — IPs are shared behind NAT/corporate proxies and unstable
 * behind mobile carriers, so limiting by IP either punishes innocent
 * co-tenants of the same address or lets an attacker rotate IPs to dodge it
 * entirely; user id is stable and directly tied to who's actually making
 * the requests). Must run after requireAuth, since it needs req.user.
 *
 * Storage is a single process-local Map — buckets do not survive a
 * restart and are not shared across multiple server instances behind a
 * load balancer. That's a real, named limitation, not an oversight: a
 * horizontally-scaled deployment needs a shared store (Redis is the usual
 * choice, e.g. via a Lua script for atomic check-and-decrement) so a user
 * can't just get N free requests per server instance instead of N total.
 * For this app's actual deployment shape (one server process), a local Map
 * is the correct, not just convenient, choice.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const buckets = new Map<string, TokenBucket>();
  const refillPerMs = options.refillPerSecond / 1000;

  return function rateLimit(req: AuthedRequest, _res: Response, next: NextFunction) {
    const key = `${options.keyPrefix}:${req.user!.id}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(options.capacity, refillPerMs);
      buckets.set(key, bucket);
    }

    if (bucket.tryConsume()) {
      next();
      return;
    }

    next(new RateLimitError(bucket.secondsUntilNextToken()));
  };
}
