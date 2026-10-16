import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Manager } from 'socket.io-client';
import { RECONNECTION_OPTIONS } from './reconnectionOptions';
import { attachConnectionLifecycle } from './connectionLifecycle';

/**
 * Deterministic backoff tests (Phase 16 — ARCHITECTURE_V2.md §13).
 *
 * Reconnection timing is the textbook thing that is either slow to test
 * (real waits: the schedule reaches 30s) or flaky (racing real timers). Here
 * the REAL Socket.IO Manager is built from the app's REAL options, only its
 * network step (`open`) is replaced by one that fails instantly, and virtual
 * time is advanced by hand. Every assertion is on exact milliseconds and the
 * whole file runs in a few milliseconds of real time.
 *
 * (`reconnect()` is private in Socket.IO's types — it is what the Manager
 * calls itself on a lost connection; the tests call it to start the loop
 * without needing a network that actually drops.)
 */

type Open = (cb: (err?: Error) => void) => void;
interface ManagerInternals {
  open: Open;
  reconnect(): void;
  backoff: { attempts: number };
}

const URL = 'http://127.0.0.1:1'; // never actually dialled: open() is stubbed

function managerWith(failures: number | 'forever', randomValue: number | null = 0) {
  if (randomValue !== null) vi.spyOn(Math, 'random').mockReturnValue(randomValue);
  const manager = new Manager(URL, { ...RECONNECTION_OPTIONS, autoConnect: false });
  const internals = manager as unknown as ManagerInternals;
  const attemptTimes: number[] = [];
  let failuresLeft = failures === 'forever' ? Infinity : failures;
  manager.on('reconnect_attempt', () => attemptTimes.push(Date.now()));
  internals.open = (cb) => {
    if (failuresLeft > 0) {
      failuresLeft--;
      cb(new Error('connection refused'));
    } else {
      // Mirrors a successful open: the Manager's own callback path calls onreconnect().
      cb();
    }
  };
  return { manager, internals, attemptTimes };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the shipped reconnection options', () => {
  it('are the documented policy', () => {
    expect(RECONNECTION_OPTIONS).toEqual({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      randomizationFactor: 0.5,
      reconnectionAttempts: Infinity,
    });
  });
});

describe('backoff schedule (jitter pinned to zero so the numbers are exact)', () => {
  it('doubles every failed attempt: 1s, 2s, 4s, 8s, 16s — then holds at the 30s cap', async () => {
    const { internals, attemptTimes } = managerWith('forever', 0);
    internals.reconnect();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000 + 30000 + 30000 + 30000);

    const gaps = attemptTimes.map((t, i) => t - (attemptTimes[i - 1] ?? 0));
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(attemptTimes[0]).toBe(1000); // measured from virtual t=0
  });

  it('never fires early: nothing at 999ms, the attempt at exactly 1000ms', async () => {
    const { internals, attemptTimes } = managerWith('forever', 0);
    internals.reconnect();

    await vi.advanceTimersByTimeAsync(999);
    expect(attemptTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attemptTimes).toEqual([1000]);
  });

  it('never gives up: a hundred consecutive failures are all rescheduled', async () => {
    const { internals, attemptTimes } = managerWith('forever', 0);
    internals.reconnect();
    await vi.advanceTimersByTimeAsync(30_000 * 100 + 31_000);
    expect(attemptTimes.length).toBeGreaterThanOrEqual(100);
  });

  it('a successful reconnect resets the schedule: the next outage starts again at 1s, not at the cap', async () => {
    const { manager, internals, attemptTimes } = managerWith(3, 0); // fail, fail, fail, then succeed
    internals.reconnect();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000);
    expect(attemptTimes).toHaveLength(4);
    expect(internals.backoff.attempts).toBe(0); // reset by the success

    // A fresh outage later.
    const before = Date.now();
    attemptTimes.length = 0;
    (manager as unknown as ManagerInternals).open = (cb) => cb(new Error('down again'));
    internals.reconnect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(attemptTimes[0] - before).toBe(1000);
  });
});

describe('jitter (the thundering-herd defence)', () => {
  it('every delay lands inside ±50% of the nominal value, for every possible random draw', async () => {
    const nominal = [1000, 2000, 4000, 8000, 16000, 30000];
    // 100 evenly spaced draws across [0, 1): covers both the "add" and "subtract" branches of the jitter formula.
    for (let step = 0; step < 100; step++) {
      vi.restoreAllMocks();
      const { internals, attemptTimes } = managerWith('forever', step / 100);
      const startedAt = Date.now();
      internals.reconnect();
      await vi.advanceTimersByTimeAsync(30_000 * 2 * nominal.length);

      let previous = startedAt;
      attemptTimes.slice(0, nominal.length).forEach((t, i) => {
        const gap = t - previous;
        previous = t;
        expect(gap, `draw ${step / 100}, attempt ${i}`).toBeGreaterThanOrEqual(nominal[i] * 0.5);
        // The cap is absolute: jitter may never push a delay past 30s.
        expect(gap, `draw ${step / 100}, attempt ${i}`).toBeLessThanOrEqual(Math.min(nominal[i] * 1.5, 30000));
      });
      internals.reconnect = () => undefined; // stop this manager's loop before the next iteration
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('two clients that lost the connection at the same instant do NOT retry at the same instant', async () => {
    // Real randomness, no pinning: this is the property jitter exists for.
    const a = managerWith('forever', null);
    const b = managerWith('forever', null);
    a.internals.reconnect();
    b.internals.reconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    const firstA = a.attemptTimes[0];
    const firstB = b.attemptTimes[0];
    // 1000ms ±50% has ~1000 distinct integer outcomes: a collision is a ~0.1% event.
    expect(firstA).not.toBe(firstB);
  });
});

describe('a planned restart (server_shutdown) skips the FIRST backoff — and only the first', () => {
  it('with the real Manager: first retry after the notice is immediate; the next waits the normal doubled delay', async () => {
    const { manager, internals, attemptTimes } = managerWith('forever', 0);
    const socket = manager.socket('/');
    attachConnectionLifecycle(socket, {
      refreshAccessToken: async () => true,
      getAccessToken: () => 't',
      flushOutbox: () => undefined,
    });

    // The server announces the shutdown, then the connection drops.
    (socket as unknown as { emitReserved: (ev: string, ...a: unknown[]) => void }).emitReserved('server_shutdown', () => undefined);
    (socket as unknown as { emitReserved: (ev: string, ...a: unknown[]) => void }).emitReserved('disconnect', 'transport close');
    internals.reconnect(); // what the Manager does when the transport closes

    await vi.advanceTimersByTimeAsync(0);
    expect(attemptTimes).toEqual([0]); // immediate: no 1s wait

    // The attempt failed, so the normal machinery takes over again — with the
    // configured delay restored, not stuck at zero (a zero delay forever would
    // hammer a server that is genuinely down).
    await vi.advanceTimersByTimeAsync(1999);
    expect(attemptTimes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attemptTimes).toEqual([0, 2000]);
    expect(manager.reconnectionDelay()).toBe(1000);
  });

  it('control: the same drop WITHOUT a preceding notice waits the full first delay', async () => {
    const { manager, internals, attemptTimes } = managerWith('forever', 0);
    const socket = manager.socket('/');
    attachConnectionLifecycle(socket, {
      refreshAccessToken: async () => true,
      getAccessToken: () => 't',
      flushOutbox: () => undefined,
    });
    (socket as unknown as { emitReserved: (ev: string, ...a: unknown[]) => void }).emitReserved('disconnect', 'transport close');
    internals.reconnect();

    await vi.advanceTimersByTimeAsync(999);
    expect(attemptTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attemptTimes).toEqual([1000]);
  });
});
