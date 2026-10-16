import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * shutdownState is a process-wide flag, so each test gets a fresh copy of
 * every module via resetModules + dynamic import — otherwise the first test
 * to run shutdown would make every later one a no-op.
 */
async function load() {
  vi.resetModules();
  const shutdown = await import('../src/lifecycle/shutdown');
  const state = await import('../src/lifecycle/shutdownState');
  const presence = await import('../src/realtime/presence');
  return { ...shutdown, ...state, suspendPresenceSpy: vi.spyOn(presence, 'suspendPresence') };
}

function fakeIo(opts: { closeCallsBack?: boolean; responses?: unknown[]; ackError?: Error | null } = {}) {
  const calls: string[] = [];
  const io = {
    timeout: vi.fn((_ms: number) => ({
      emit: (event: string, cb: (err: Error | null, responses: unknown[]) => void) => {
        calls.push(`emit:${event}`);
        cb(opts.ackError ?? null, opts.responses ?? [{}, {}]);
      },
    })),
    close: vi.fn((cb: () => void) => {
      calls.push('io.close');
      if (opts.closeCallsBack !== false) cb();
    }),
  };
  return { io: io as unknown as Parameters<Awaited<ReturnType<typeof load>>['createShutdownHandler']>[0]['io'], calls, raw: io };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createShutdownHandler', () => {
  it('runs the steps in order: notify clients -> close sockets/http -> close DB -> exit 0', async () => {
    const m = await load();
    const { io, calls } = fakeIo();
    const exit = vi.fn((_c: number) => calls.push('exit'));
    const closePool = vi.fn(async () => {
      calls.push('pool.end');
    });

    await m.createShutdownHandler({ io, closePool, exit, ackTimeoutMs: 3000, hardTimeoutMs: 10000 })('SIGTERM');

    // The ordering IS the design: tell clients first (so they reconnect
    // immediately), close connections second, release the DB last (closing
    // connections can still trigger handlers that query it).
    expect(calls).toEqual(['emit:server_shutdown', 'io.close', 'pool.end', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(m.suspendPresenceSpy).toHaveBeenCalledTimes(1);
  });

  it('flips the health flag immediately and ignores a second signal', async () => {
    const m = await load();
    const { io, raw } = fakeIo();
    const exit = vi.fn();
    const handler = m.createShutdownHandler({ io, closePool: async () => {}, exit, ackTimeoutMs: 3000, hardTimeoutMs: 10000 });

    expect(m.isShuttingDown()).toBe(false);
    const first = handler('SIGTERM');
    expect(m.isShuttingDown()).toBe(true); // set synchronously, before any await
    await first;
    await handler('SIGTERM'); // an orchestrator re-sending, or Ctrl-C mashing

    expect(raw.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('waits for the ack callback, passes the configured timeout, and still proceeds when clients time out', async () => {
    const m = await load();
    const { io, raw, calls } = fakeIo({ ackError: new Error('operation has timed out'), responses: [{}] });
    const exit = vi.fn();

    await m.createShutdownHandler({ io, closePool: async () => {}, exit, ackTimeoutMs: 1234, hardTimeoutMs: 10000 })('SIGTERM');

    expect(raw.timeout).toHaveBeenCalledWith(1234);
    // A client that never answers is a log line, not a reason to abort.
    expect(calls).toContain('io.close');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a hung step is cut off by the hard timeout with a NON-zero exit', async () => {
    const m = await load();
    const { io } = fakeIo({ closeCallsBack: false }); // io.close never calls back
    const exit = vi.fn();

    void m.createShutdownHandler({ io, closePool: async () => {}, exit, ackTimeoutMs: 3000, hardTimeoutMs: 10000 })('SIGTERM');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a failure while closing exits non-zero instead of hanging or lying', async () => {
    const m = await load();
    const { io } = fakeIo();
    const exit = vi.fn();
    const closePool = vi.fn(async () => {
      throw new Error('pool exploded');
    });

    await m.createShutdownHandler({ io, closePool, exit, ackTimeoutMs: 3000, hardTimeoutMs: 10000 })('SIGTERM');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('/health during shutdown', () => {
  it('returns 200 normally and 503 {shuttingDown:true} once shutdown has begun', async () => {
    vi.useRealTimers(); // supertest needs real timers
    vi.resetModules();
    const { createApp } = await import('../src/app');
    const state = await import('../src/lifecycle/shutdownState');
    const { default: supertest } = await import('supertest');
    const app = createApp();

    const before = await supertest(app).get('/health');
    expect(before.status).toBe(200);

    state.markShuttingDown();
    const after = await supertest(app).get('/health');
    expect(after.status).toBe(503);
    expect(after.body).toEqual({ ok: false, shuttingDown: true });
  });
});
