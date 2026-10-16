import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import { registerReauthHandlers } from '../src/realtime/reauth.socket';
import { env } from '../src/config/env';

/**
 * Phase 15 exercise T2 — "time is a bug".
 *
 * setTimeout stores its delay in a signed 32-bit integer. Anything above
 * 2^31 - 1 ms (24.8 days) is not "a long wait": Node silently rewrites it to
 * 1ms (and prints TimeoutOverflowWarning). A naive `setTimeout(expire,
 * msUntilExpiry)` for a 30-day token therefore disconnects a perfectly
 * healthy socket one millisecond after it connects.
 */
class FakeSocket extends EventEmitter {
  id = 'sock-long';
  data: Record<string, unknown> = {};
  sent: Array<{ event: string; payload: unknown }> = [];
  disconnected = false;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (typeof event === 'string' && ['token_expiring', 'disconnect_reason'].includes(event)) {
      this.sent.push({ event, payload: args[0] });
      return true;
    }
    return super.emit(event, ...args);
  }
  disconnect() {
    this.disconnected = true;
    return this;
  }
}

const DAY = 24 * 60 * 60 * 1000;

function connectWithLifetimeDays(days: number) {
  const token = jwt.sign({ sub: '1' }, env.jwtSecret, { algorithm: 'HS256', expiresIn: Math.round((days * DAY) / 1000) });
  const exp = (jwt.decode(token) as { exp: number }).exp;
  const s = new FakeSocket();
  s.data = { userId: 1, tokenExpiresAtMs: exp * 1000 };
  registerReauthHandlers({} as never, s as never);
  return s;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('T2 — a token that outlives setTimeout (30 days > 24.8 days)', () => {
  it('does NOT expire a healthy socket right after connect', () => {
    const s = connectWithLifetimeDays(30);
    vi.advanceTimersByTime(10_000);
    expect(s.disconnected).toBe(false);
    expect(s.sent).toHaveLength(0);
  });

  it('does not turn into a timer storm: a 30-day token creates a handful of timers, not one per millisecond', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    connectWithLifetimeDays(30);
    vi.advanceTimersByTime(60_000);
    // Without the clamp, setTimeout rewrites the huge delay to 1ms, the expiry
    // callback sees a still-valid token and re-arms, which is again 1ms...
    // ~60,000 timers per minute per socket. With it: just the two armed at connect.
    expect(spy.mock.calls.length).toBeLessThan(10);
    spy.mockRestore();
  });

  it('re-arms when the clamped timer fires early, and still warns + expires at the REAL deadline', () => {
    const s = connectWithLifetimeDays(30);

    vi.advanceTimersByTime(26 * DAY); // past the 24.8-day clamp: timers fired early and re-armed
    expect(s.disconnected).toBe(false);

    vi.advanceTimersByTime(4 * DAY - env.tokenExpiryWarningLeadMs - 5_000);
    expect(s.sent).toHaveLength(0); // still not time to warn

    vi.advanceTimersByTime(10_000);
    expect(s.sent.map((e) => e.event)).toEqual(['token_expiring']);

    vi.advanceTimersByTime(env.tokenExpiryWarningLeadMs + 5_000);
    expect(s.sent.map((e) => e.event)).toEqual(['token_expiring', 'disconnect_reason']);
    expect(s.disconnected).toBe(true);
  });
});
