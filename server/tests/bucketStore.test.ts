import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBucketStore } from '../src/rateLimit/bucketStore';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bucketStore', () => {
  it('allows exactly `capacity` back-to-back consumes, then refuses with a retry hint', () => {
    const store = createBucketStore({ capacity: 3, refillPerSecond: 1 });

    expect(store.consume('u1')).toEqual({ allowed: true });
    expect(store.consume('u1')).toEqual({ allowed: true });
    expect(store.consume('u1')).toEqual({ allowed: true });

    const refused = store.consume('u1');
    expect(refused.allowed).toBe(false);
    // Never "retry in 0s" — a caller told that hammers straight back.
    expect(refused.allowed === false && refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('keys are independent: one user exhausting their bucket does not touch another', () => {
    const store = createBucketStore({ capacity: 2, refillPerSecond: 1 });
    store.consume('flooder');
    store.consume('flooder');
    expect(store.consume('flooder').allowed).toBe(false);

    // The DoD claim in miniature: "without affecting other users".
    expect(store.consume('bystander')).toEqual({ allowed: true });
    expect(store.consume('bystander')).toEqual({ allowed: true });
  });

  it('refills over time (lazily, no timers) and recovers', () => {
    const store = createBucketStore({ capacity: 2, refillPerSecond: 2 });
    store.consume('u');
    store.consume('u');
    expect(store.consume('u').allowed).toBe(false);

    vi.advanceTimersByTime(500); // 2 tokens/sec -> 1 token per 500ms
    expect(store.consume('u').allowed).toBe(true);
    expect(store.consume('u').allowed).toBe(false);
  });

  it('two consumers of the SAME store spend from one budget (the cross-transport guarantee)', () => {
    const store = createBucketStore({ capacity: 4, refillPerSecond: 1 });
    const viaHttp = () => store.consume('alice');
    const viaSocket = () => store.consume('alice');

    expect(viaHttp().allowed).toBe(true);
    expect(viaSocket().allowed).toBe(true);
    expect(viaHttp().allowed).toBe(true);
    expect(viaSocket().allowed).toBe(true);
    // 4 spent across two "transports" — the fifth is refused from either.
    expect(viaHttp().allowed).toBe(false);
    expect(viaSocket().allowed).toBe(false);
  });

  it('sweep() drops only buckets that have fully refilled, never ones still carrying state', () => {
    const store = createBucketStore({ capacity: 2, refillPerSecond: 1 });
    store.consume('drained'); // 1 token left of 2 — has state
    store.consume('drained');
    store.consume('idle'); // 1 of 2 spent...
    expect(store.size()).toBe(2);

    vi.advanceTimersByTime(1_000); // 'idle' is back to full; 'drained' is at 1 of 2
    expect(store.sweep()).toBe(1);
    expect(store.size()).toBe(1);

    // The swept key behaves exactly like a brand-new one — nothing was lost.
    expect(store.consume('idle')).toEqual({ allowed: true });
    // The retained one still remembers it was drained.
    expect(store.consume('drained')).toEqual({ allowed: true }); // had refilled to 1
    expect(store.consume('drained').allowed).toBe(false);
  });

  it('consume() sweeps opportunistically after sweepIntervalMs, bounding memory without any timer', () => {
    const store = createBucketStore({ capacity: 1, refillPerSecond: 10, sweepIntervalMs: 5_000 });
    for (let i = 0; i < 100; i++) store.consume(`user-${i}`);
    expect(store.size()).toBe(100);

    vi.advanceTimersByTime(6_000); // everyone has long since refilled
    store.consume('trigger'); // an ordinary call is what runs the sweep
    // 100 idle buckets reclaimed; only the one just created remains.
    expect(store.size()).toBe(1);
  });
});
