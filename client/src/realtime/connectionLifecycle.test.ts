import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachConnectionLifecycle, type LifecycleDeps } from './connectionLifecycle';

/**
 * A just-enough Socket and Manager. Everything connectionLifecycle.ts does
 * to a real socket is on/off/timeout().emit/connect/disconnect plus the
 * Manager's reconnectionDelay getter/setter and once(), so that is exactly
 * what's faked — and every branch is then drivable deterministically with
 * fake timers. The real-library behavior these tests lean on (for example,
 * that 'disconnect' fires before the Manager computes its next delay) is
 * checked against the real socket.io-client by server/scripts/shutdown-test.mjs.
 */
class FakeManager {
  delay = 1000;
  private onceHandlers = new Map<string, Array<() => void>>();
  reconnectionDelay(v?: number): number | this {
    if (v === undefined) return this.delay;
    this.delay = v;
    return this;
  }
  once(event: string, fn: () => void): this {
    const list = this.onceHandlers.get(event) ?? [];
    list.push(fn);
    this.onceHandlers.set(event, list);
    return this;
  }
  fire(event: string): void {
    const list = this.onceHandlers.get(event) ?? [];
    this.onceHandlers.delete(event);
    for (const fn of list) fn();
  }
}

class FakeSocket {
  io = new FakeManager();
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  emitted: Array<{ event: string; args: unknown[] }> = [];
  connectCalls = 0;
  disconnectCalls = 0;
  /** Decides how the "server" answers a reauth emit. */
  reauthAnswer: (cb: (err: Error | null, result?: { ok: boolean }) => void) => void = (cb) => cb(null, { ok: true });

  on(event: string, fn: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: (...args: any[]) => void): this {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  trigger(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }
  listenerCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
  timeout(_ms: number) {
    return {
      emit: (event: string, payload: unknown, cb: (err: Error | null, result?: { ok: boolean }) => void) => {
        this.emitted.push({ event, args: [payload] });
        this.reauthAnswer(cb);
      },
    };
  }
  connect(): this {
    this.connectCalls += 1;
    return this;
  }
  disconnect(): this {
    this.disconnectCalls += 1;
    return this;
  }
}

function setup(depsOverride: Partial<LifecycleDeps> = {}, options = {}) {
  const socket = new FakeSocket();
  const log: string[] = [];
  let token: string | null = 'old-token';
  const deps: LifecycleDeps = {
    refreshAccessToken: vi.fn(async () => {
      log.push('refresh');
      token = 'new-token';
      return true;
    }),
    getAccessToken: () => token,
    flushOutbox: vi.fn(() => log.push('flush')),
    ...depsOverride,
  };
  const detach = attachConnectionLifecycle(socket as never, deps, { random: () => 0, ...options });
  return { socket, deps, log, detach };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('server_shutdown (planned restart)', () => {
  it('acks the notice so the server can stop waiting', () => {
    const { socket } = setup();
    const ack = vi.fn();
    socket.trigger('server_shutdown', ack);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('the next disconnect gets a ZERO first-retry delay, restored the moment that attempt starts', () => {
    const { socket } = setup();
    socket.trigger('server_shutdown', vi.fn());
    socket.trigger('disconnect', 'transport close');

    expect(socket.io.delay).toBe(0); // first attempt: immediately

    socket.io.fire('reconnect_attempt'); // the attempt begins...
    // ...and ordinary backoff is back, so a server that ISN'T up yet isn't
    // hit by a hot loop of zero-delay retries.
    expect(socket.io.delay).toBe(1000);
  });

  it('a disconnect with no preceding notice leaves the backoff completely alone', () => {
    const { socket } = setup();
    socket.trigger('disconnect', 'transport close');
    expect(socket.io.delay).toBe(1000);
  });

  it('only the first disconnect after a notice is affected', () => {
    const { socket } = setup();
    socket.trigger('server_shutdown', vi.fn());
    socket.trigger('disconnect', 'transport close');
    socket.io.fire('reconnect_attempt');

    socket.trigger('disconnect', 'transport close'); // a later, unrelated drop
    expect(socket.io.delay).toBe(1000);
  });

  it('a stale notice (the shutdown never happened) does not skip backoff for some later unrelated drop', () => {
    let t = 0;
    const { socket } = setup({}, { now: () => t });
    socket.trigger('server_shutdown', vi.fn());
    t = 31_000; // older than the 30s notice TTL
    socket.trigger('disconnect', 'transport close');
    expect(socket.io.delay).toBe(1000);
  });

  it("if the server closes us explicitly ('io server disconnect'), Socket.IO won't retry on its own — connect immediately", () => {
    const { socket } = setup();
    socket.trigger('server_shutdown', vi.fn());
    socket.trigger('disconnect', 'io server disconnect');
    expect(socket.connectCalls).toBe(1);
    expect(socket.io.delay).toBe(1000); // untouched: no auto-retry to speed up
  });
});

describe('token_expiring (mid-connection reauth)', () => {
  it('refreshes FIRST, then reauths on the same socket with the NEW token — no disconnect', async () => {
    const { socket, log } = setup();
    socket.trigger('token_expiring', { expiresInMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual(['refresh']);
    expect(socket.emitted).toEqual([{ event: 'reauth', args: [{ token: 'new-token' }] }]);
    expect(socket.disconnectCalls).toBe(0);
    expect(socket.connectCalls).toBe(0);
  });

  it('jitters the refresh so two tabs warned at the same instant do not hit /auth/refresh together', async () => {
    const { socket, deps } = setup({}, { random: () => 0.5, reauthJitterMaxMs: 1000 });
    socket.trigger('token_expiring', {});
    await vi.advanceTimersByTimeAsync(499);
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('a second warning while one reauth is in flight is ignored (one refresh, one reauth)', async () => {
    const { socket, deps } = setup();
    socket.trigger('token_expiring', {});
    socket.trigger('token_expiring', {});
    socket.trigger('token_expiring', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.emitted.filter((e) => e.event === 'reauth')).toHaveLength(1);
  });

  it('can reauth again on the NEXT warning (the in-flight guard resets)', async () => {
    const { socket, deps } = setup();
    socket.trigger('token_expiring', {});
    await vi.advanceTimersByTimeAsync(0);
    socket.trigger('token_expiring', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('if the session is gone (refresh fails) it emits nothing — the auth layer owns logout', async () => {
    const { socket } = setup({ refreshAccessToken: vi.fn(async () => false) });
    socket.trigger('token_expiring', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.emitted).toHaveLength(0);
    expect(socket.disconnectCalls).toBe(0);
  });

  it('if the server refuses the reauth, falls back to a clean disconnect + connect', async () => {
    const { socket } = setup();
    socket.reauthAnswer = (cb) => cb(null, { ok: false });
    socket.trigger('token_expiring', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.disconnectCalls).toBe(1);
    expect(socket.connectCalls).toBe(1);
  });

  it('if the reauth ack times out, falls back the same way', async () => {
    const { socket } = setup();
    socket.reauthAnswer = (cb) => cb(new Error('operation has timed out'));
    socket.trigger('token_expiring', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.disconnectCalls).toBe(1);
    expect(socket.connectCalls).toBe(1);
  });
});

describe('disconnect_reason: token_expired', () => {
  it('after the server force-closes us, refreshes BEFORE reconnecting (retrying the dead token would just be rejected)', async () => {
    const { socket, log } = setup();
    socket.trigger('disconnect_reason', { reason: 'token_expired' });
    socket.trigger('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual(['refresh']);
    expect(socket.connectCalls).toBe(1);
  });

  it('does not reconnect if the refresh fails (the session is over)', async () => {
    const { socket } = setup({ refreshAccessToken: vi.fn(async () => false) });
    socket.trigger('disconnect_reason', { reason: 'token_expired' });
    socket.trigger('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.connectCalls).toBe(0);
  });

  it("a plain server disconnect with no reason attached is left alone (that's a deliberate kick, not an expiry)", async () => {
    const { socket, deps } = setup();
    socket.trigger('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connectCalls).toBe(0);
  });
});

describe('connect_error: stale token on (re)connect', () => {
  it('UNAUTHORIZED -> refresh -> connect again (Socket.IO does not retry a middleware rejection on its own)', async () => {
    const { socket, log } = setup();
    socket.trigger('connect_error', new Error('UNAUTHORIZED'));
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['refresh']);
    expect(socket.connectCalls).toBe(1);
  });

  it('ignores other connect errors (server down, network) — those are the normal backoff loop\'s job', async () => {
    const { socket, deps } = setup();
    socket.trigger('connect_error', new Error('xhr poll error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connectCalls).toBe(0);
  });

  it('gives up after maxAuthRetries consecutive rejections, so a refresh that "works" but yields a still-rejected token cannot loop forever', async () => {
    const { socket } = setup({}, { maxAuthRetries: 3 });
    for (let i = 0; i < 10; i++) {
      socket.trigger('connect_error', new Error('UNAUTHORIZED'));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(socket.connectCalls).toBe(3);
  });

  it('a successful connect resets the retry budget', async () => {
    const { socket } = setup({}, { maxAuthRetries: 2 });
    for (let i = 0; i < 2; i++) {
      socket.trigger('connect_error', new Error('UNAUTHORIZED'));
      await vi.advanceTimersByTimeAsync(0);
    }
    socket.trigger('connect');
    socket.trigger('connect_error', new Error('UNAUTHORIZED'));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.connectCalls).toBe(3);
  });
});

describe('rate_limited (send_message)', () => {
  it('schedules ONE outbox flush just after the advertised delay', async () => {
    const { socket, deps } = setup();
    socket.trigger('rate_limited', { event: 'send_message', retryAfterSeconds: 2 });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.flushOutbox).not.toHaveBeenCalled(); // 100ms of slack so the token has really refilled
    await vi.advanceTimersByTimeAsync(150);
    expect(deps.flushOutbox).toHaveBeenCalledTimes(1);
  });

  it('further notices while a retry is already pending do not schedule more (a flush re-sends everything anyway)', async () => {
    const { socket, deps } = setup();
    socket.trigger('rate_limited', { event: 'send_message', retryAfterSeconds: 1 });
    socket.trigger('rate_limited', { event: 'send_message', retryAfterSeconds: 1 });
    socket.trigger('rate_limited', { event: 'send_message', retryAfterSeconds: 5 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.flushOutbox).toHaveBeenCalledTimes(1);
  });

  it('a later notice, after the retry fired, schedules a fresh one', async () => {
    const { socket, deps } = setup();
    socket.trigger('rate_limited', { event: 'send_message', retryAfterSeconds: 1 });
    await vi.advanceTimersByTimeAsync(1_200);
    socket.trigger('rate_limited', { event: 'send_message', retryAfterSeconds: 1 });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(deps.flushOutbox).toHaveBeenCalledTimes(2);
  });

  it('typing notices are ignored — a dropped typing indicator is not worth retrying', async () => {
    const { socket, deps } = setup();
    socket.trigger('rate_limited', { event: 'typing_start', retryAfterSeconds: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.flushOutbox).not.toHaveBeenCalled();
  });
});

describe('detach', () => {
  it('removes every listener', () => {
    const { socket, detach } = setup();
    expect(socket.listenerCount()).toBeGreaterThan(0);
    detach();
    expect(socket.listenerCount()).toBe(0);
  });

  it('cancels a pending flush and an in-progress jitter wait, and stops a reauth mid-flight', async () => {
    const { socket, deps, detach } = setup({}, { random: () => 1, reauthJitterMaxMs: 1000 });
    socket.trigger('rate_limited', { event: 'send_message', retryAfterSeconds: 1 });
    socket.trigger('token_expiring', {});
    detach();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.flushOutbox).not.toHaveBeenCalled();
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
