import { TokenBucket } from './tokenBucket';

export interface BucketStoreOptions {
  /** Max burst size — how many events can fire back-to-back. */
  capacity: number;
  /** Sustained rate once the burst is used up. */
  refillPerSecond: number;
  /** How often (at most) an opportunistic sweep of idle buckets runs.
   * Default 60s. Exposed mainly so tests don't have to wait a real minute. */
  sweepIntervalMs?: number;
}

export type ConsumeResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface BucketStore {
  /** Spend one token for `key`. Never throws; the caller decides what a
   * refusal means (HTTP: a 429, socket: a `rate_limited` event). */
  consume(key: string | number): ConsumeResult;
  /** Drops every bucket that has fully refilled. Returns how many it dropped. */
  sweep(): number;
  /** How many buckets are currently being tracked (mostly for tests). */
  size(): number;
}

/**
 * A keyed collection of token buckets, pulled out of the Express
 * rate-limit middleware (Phase 7) so the SAME budget can be spent from
 * more than one transport. That's the actual reason this module exists:
 * before Phase 15 the HTTP `POST /rooms/:id/messages` limiter owned its
 * buckets privately, so if the socket path had built its own, a client
 * could simply alternate transports and get double the intended rate.
 * One store per *thing being limited* (send, poll, typing), consumed by
 * whichever transport(s) can perform that thing, is what closes that.
 *
 * Process-local, like the v1 limiter it was extracted from: buckets don't
 * survive a restart and aren't shared across instances (ARCHITECTURE_V2.md
 * §12 — a horizontally scaled deployment needs a shared store such as
 * Redis; this one is the correct choice for a single process).
 *
 * Memory: v1's Map grew by one bucket per distinct user, forever. A bucket
 * that has refilled to capacity carries no information (a brand-new one is
 * identical), so consume() opportunistically sweeps those away at most once
 * per `sweepIntervalMs`. Done inline rather than with a setInterval: no
 * timer to leak or unref, nothing running when nobody is calling, and it
 * stays deterministic under fake timers.
 */
export function createBucketStore(options: BucketStoreOptions): BucketStore {
  const buckets = new Map<string | number, TokenBucket>();
  const refillPerMs = options.refillPerSecond / 1000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  let lastSweepAt = Date.now();

  function sweep(): number {
    let removed = 0;
    // Deleting from a Map while iterating it is well-defined in JS.
    for (const [key, bucket] of buckets) {
      if (bucket.isFull()) {
        buckets.delete(key);
        removed++;
      }
    }
    lastSweepAt = Date.now();
    return removed;
  }

  return {
    consume(key) {
      if (Date.now() - lastSweepAt >= sweepIntervalMs) sweep();

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = new TokenBucket(options.capacity, refillPerMs);
        buckets.set(key, bucket);
      }

      if (bucket.tryConsume()) return { allowed: true };
      // Never report 0: a refusal always means "not yet", and a caller
      // that is told "retry in 0s" will hammer straight back.
      return { allowed: false, retryAfterSeconds: Math.max(1, bucket.secondsUntilNextToken()) };
    },
    sweep,
    size: () => buckets.size,
  };
}
