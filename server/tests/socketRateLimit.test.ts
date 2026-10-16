import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBucketStore } from '../src/rateLimit/bucketStore';
import { enforceSocketRateLimit } from '../src/realtime/socketRateLimit';

function fakeSocket(userId: number, id = `sock-${userId}`) {
  return { id, data: { userId } as Record<string, unknown>, emit: vi.fn() };
}
type FakeSocket = ReturnType<typeof fakeSocket>;
const asSocket = (s: FakeSocket) => s as unknown as Parameters<typeof enforceSocketRateLimit>[0];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('enforceSocketRateLimit', () => {
  it('allowed events return true and emit nothing', () => {
    const store = createBucketStore({ capacity: 3, refillPerSecond: 1 });
    const s = fakeSocket(1);
    expect(enforceSocketRateLimit(asSocket(s), store, 'send_message')).toBe(true);
    expect(s.emit).not.toHaveBeenCalled();
  });

  it('a refused event returns false and tells THIS socket, once, with a retry hint', () => {
    const store = createBucketStore({ capacity: 1, refillPerSecond: 1 });
    const s = fakeSocket(1);
    enforceSocketRateLimit(asSocket(s), store, 'send_message'); // spends the only token

    expect(enforceSocketRateLimit(asSocket(s), store, 'send_message')).toBe(false);
    expect(s.emit).toHaveBeenCalledTimes(1);
    expect(s.emit).toHaveBeenCalledWith('rate_limited', {
      event: 'send_message',
      retryAfterSeconds: expect.any(Number),
    });
    expect(s.emit.mock.calls[0][1].retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('a flood is answered with ONE notice, not one per refused event (no amplification)', () => {
    const store = createBucketStore({ capacity: 1, refillPerSecond: 1 });
    const s = fakeSocket(1);
    enforceSocketRateLimit(asSocket(s), store, 'typing_start');

    for (let i = 0; i < 500; i++) enforceSocketRateLimit(asSocket(s), store, 'typing_start');

    expect(s.emit).toHaveBeenCalledTimes(1);
  });

  it('after the advertised window, a still-misbehaving client gets a fresh notice', () => {
    const store = createBucketStore({ capacity: 1, refillPerSecond: 0.1 }); // 10s per token
    const s = fakeSocket(1);
    enforceSocketRateLimit(asSocket(s), store, 'send_message');
    enforceSocketRateLimit(asSocket(s), store, 'send_message'); // notice #1
    expect(s.emit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    enforceSocketRateLimit(asSocket(s), store, 'send_message'); // inside the window
    expect(s.emit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000); // t=12s: the notice window (10s) is over AND one token has refilled
    enforceSocketRateLimit(asSocket(s), store, 'send_message'); // spends that refilled token (allowed)
    enforceSocketRateLimit(asSocket(s), store, 'send_message'); // refused again, window over -> notice #2
    expect(s.emit).toHaveBeenCalledTimes(2);
  });

  it('notices are tracked per event type, not per socket', () => {
    const store = createBucketStore({ capacity: 1, refillPerSecond: 1 });
    const s = fakeSocket(1);
    enforceSocketRateLimit(asSocket(s), store, 'typing_start'); // spend
    enforceSocketRateLimit(asSocket(s), store, 'typing_start'); // refused -> notice for typing_start
    enforceSocketRateLimit(asSocket(s), store, 'typing_stop'); // refused (shared bucket) -> its OWN notice

    expect(s.emit).toHaveBeenCalledTimes(2);
    expect(s.emit.mock.calls.map((c) => c[1].event)).toEqual(['typing_start', 'typing_stop']);
  });

  it("one user's flood never refuses another user, and never notifies their socket", () => {
    const store = createBucketStore({ capacity: 2, refillPerSecond: 1 });
    const flooder = fakeSocket(1);
    const bystander = fakeSocket(2);

    for (let i = 0; i < 50; i++) enforceSocketRateLimit(asSocket(flooder), store, 'send_message');

    expect(enforceSocketRateLimit(asSocket(bystander), store, 'send_message')).toBe(true);
    expect(bystander.emit).not.toHaveBeenCalled();
  });

  it("budget is per USER: a second socket for the same user shares it (extra tabs aren't a loophole)", () => {
    const store = createBucketStore({ capacity: 2, refillPerSecond: 1 });
    const tabA = fakeSocket(1, 'tab-a');
    const tabB = fakeSocket(1, 'tab-b');

    enforceSocketRateLimit(asSocket(tabA), store, 'send_message');
    enforceSocketRateLimit(asSocket(tabA), store, 'send_message');
    // Tab A drained the user's budget; tab B must not get a fresh allowance.
    expect(enforceSocketRateLimit(asSocket(tabB), store, 'send_message')).toBe(false);
    expect(tabB.emit).toHaveBeenCalledWith('rate_limited', expect.objectContaining({ event: 'send_message' }));
  });
});
