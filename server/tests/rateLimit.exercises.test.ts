import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBucketStore } from '../src/rateLimit/bucketStore';
import { enforceSocketRateLimit } from '../src/realtime/socketRateLimit';

/**
 * Phase 15 exercises M1 and M2 — written as tests so the answers can't drift
 * from the code they describe.
 */

function fakeSocket(userId: number, id: string) {
  return { id, data: { userId } as Record<string, unknown>, emit: vi.fn() };
}
const asSocket = (s: ReturnType<typeof fakeSocket>) => s as unknown as Parameters<typeof enforceSocketRateLimit>[0];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('M1 — two tabs of one user flooding at once', () => {
  it('shares ONE budget between the tabs, but each tab keeps its own notice throttle', () => {
    const store = createBucketStore({ capacity: 10, refillPerSecond: 2 });
    const tabA = fakeSocket(7, 'tab-A');
    const tabB = fakeSocket(7, 'tab-B');

    let allowedA = 0;
    let allowedB = 0;
    for (let i = 0; i < 100; i++) {
      if (enforceSocketRateLimit(asSocket(tabA), store, 'send_message')) allowedA++;
      if (enforceSocketRateLimit(asSocket(tabB), store, 'send_message')) allowedB++;
    }

    // Budget is per USER: both tabs together get 10, not 10 each.
    expect(allowedA + allowedB).toBe(10);

    // Notices are per SOCKET: each tab is told once (it can't see the other
    // tab's refusals, so it needs its own notice to know to back off).
    expect(tabA.emit).toHaveBeenCalledTimes(1);
    expect(tabB.emit).toHaveBeenCalledTimes(1);
  });

  it('a different user is untouched by that flood', () => {
    const store = createBucketStore({ capacity: 10, refillPerSecond: 2 });
    const flooder = fakeSocket(7, 'tab-A');
    const bystander = fakeSocket(8, 'tab-C');
    for (let i = 0; i < 100; i++) enforceSocketRateLimit(asSocket(flooder), store, 'send_message');

    expect(enforceSocketRateLimit(asSocket(bystander), store, 'send_message')).toBe(true);
    expect(bystander.emit).not.toHaveBeenCalled();
  });

  it('keying by socket.id instead (the tempting bug) would hand every extra tab a fresh allowance', () => {
    // Demonstrates WHY the key is userId: same flood, but keyed per socket.
    const store = createBucketStore({ capacity: 10, refillPerSecond: 2 });
    let allowed = 0;
    for (const socketId of ['a', 'b', 'c', 'd', 'e']) {
      for (let i = 0; i < 100; i++) if (store.consume(socketId).allowed) allowed++;
    }
    expect(allowed).toBe(50); // 5 tabs = 5x the intended budget
  });
});

describe('M2 — the sweep is opportunistic, not scheduled', () => {
  it('leaves no timer behind, and cleans up only when somebody next calls consume()', () => {
    const store = createBucketStore({ capacity: 10, refillPerSecond: 2, sweepIntervalMs: 60_000 });

    for (let u = 0; u < 1000; u++) store.consume(`user-${u}`); // each leaves a 9/10-full bucket
    expect(store.size()).toBe(1000);
    expect(vi.getTimerCount()).toBe(0); // nothing is scheduled to clean up later

    // A full minute of silence. Every bucket has long since refilled...
    vi.advanceTimersByTime(60_000);
    // ...but nobody has asked the store anything, so nothing has run.
    expect(store.size()).toBe(1000);

    // The next consume() from ANYONE pays for the sweep.
    store.consume('latecomer');
    expect(store.size()).toBe(1); // 1000 full buckets swept; only the latecomer remains
  });

  it('never sweeps a bucket that is still carrying debt', () => {
    const store = createBucketStore({ capacity: 10, refillPerSecond: 2, sweepIntervalMs: 60_000 });
    for (let i = 0; i < 10; i++) store.consume('debtor'); // empty
    vi.advanceTimersByTime(1_000); // refills 2 tokens: NOT full
    expect(store.sweep()).toBe(0);
    expect(store.size()).toBe(1);

    vi.advanceTimersByTime(10_000); // now comfortably full
    expect(store.sweep()).toBe(1);
    expect(store.size()).toBe(0);
  });
});
