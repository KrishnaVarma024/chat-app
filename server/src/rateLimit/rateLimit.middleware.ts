import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../auth/auth.middleware';
import { createBucketStore, type BucketStore } from './bucketStore';
import { RateLimitError } from '../errors';

export interface RateLimiterOptions {
  /** Max burst size — how many requests can fire back-to-back before
   * throttling kicks in. */
  capacity: number;
  /** Sustained rate once the burst is used up. */
  refillPerSecond: number;
}

/**
 * Per-user token-bucket rate limiting as Express middleware, keyed by the
 * authenticated user's id (never by IP — IPs are shared behind NAT/corporate
 * proxies and unstable behind mobile carriers, so limiting by IP either
 * punishes innocent co-tenants of the same address or lets an attacker
 * rotate IPs to dodge it entirely; user id is stable and directly tied to
 * who's actually making the requests). Must run after requireAuth, since it
 * needs req.user.
 *
 * Takes a BucketStore (Phase 15) instead of building its own buckets, so
 * the socket layer can spend from the very same store — see
 * rateLimit/limits.ts. The bucket bookkeeping itself (and its documented
 * single-process limitation) lives in bucketStore.ts.
 */
export function createRateLimitMiddleware(store: BucketStore) {
  return function rateLimit(req: AuthedRequest, _res: Response, next: NextFunction) {
    const result = store.consume(req.user!.id);
    if (result.allowed) {
      next();
      return;
    }
    next(new RateLimitError(result.retryAfterSeconds));
  };
}

/** The pre-Phase-15 entry point, kept as a thin convenience for a limiter
 * that nothing else needs to share a budget with. */
export function createRateLimiter(options: RateLimiterOptions) {
  return createRateLimitMiddleware(createBucketStore(options));
}
