/**
 * Classic token-bucket: a bucket holds up to `capacity` tokens, refills at
 * `refillPerMs` tokens per millisecond (computed lazily — see below), and
 * every request costs 1 token. Chosen over a fixed window ("N requests per
 * 10s window, reset at the boundary") specifically because fixed windows
 * let a client burst up to 2x the intended rate for free by timing
 * requests around the reset boundary (N requests right before it resets,
 * N more right after) — a token bucket has no reset edge to game, since
 * tokens trickle back continuously rather than refilling in a lump.
 *
 * Refill is computed lazily on each `tryConsume` call (elapsed time since
 * `lastRefillAt` * refillPerMs), not via a setInterval ticking in the
 * background — a bucket nobody is calling doesn't need to burn CPU staying
 * "topped up" every tick; it only needs to be correct the next time
 * someone actually asks it a question.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
    this.lastRefillAt = now;
  }

  /** Returns true and deducts a token if one was available; false (and
   * deducts nothing) otherwise. */
  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** How long (seconds, rounded up) until at least 1 token is available —
   * used to set the Retry-After header on a 429 so a well-behaved caller
   * knows exactly when to try again instead of guessing/polling harder. */
  secondsUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const msNeeded = (1 - this.tokens) / this.refillPerMs;
    return Math.ceil(msNeeded / 1000);
  }
}
