import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import { registerReauthHandlers, type ReauthResult } from '../src/realtime/reauth.socket';
import { env } from '../src/config/env';

/**
 * A just-enough Socket: registerReauthHandlers only ever calls on/emit/
 * disconnect/id/data. The TIMER logic is the thing under test, so driving it
 * with fake timers beats waiting out real expiries — the real-clock version
 * of the same claims lives in scripts/reauth-test.mjs.
 */
class FakeSocket extends EventEmitter {
  id = 'sock-1';
  data: Record<string, unknown> = {};
  sent: Array<{ event: string; payload: unknown }> = [];
  disconnected = false;

  // EventEmitter.emit would run OUR listeners for server->client events, so
  // outbound events get their own method and the handlers under test call it
  // through this override.
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (typeof event === 'string' && ['token_expiring', 'disconnect_reason'].includes(event)) {
      this.sent.push({ event, payload: args[0] });
      return true;
    }
    return super.emit(event, ...args);
  }
  disconnect(_close?: boolean) {
    this.disconnected = true;
    return this;
  }
  // Simulates the CLIENT emitting an event with an ack callback.
  clientEmit(event: string, payload: unknown): Promise<ReauthResult> {
    return new Promise((resolve) => super.emit(event, payload, resolve));
  }
}

const asSocket = (s: FakeSocket) => s as unknown as Parameters<typeof registerReauthHandlers>[1];
const noIo = {} as Parameters<typeof registerReauthHandlers>[0];

function tokenFor(userId: number, lifetimeSeconds: number): string {
  return jwt.sign({ sub: String(userId) }, env.jwtSecret, { algorithm: 'HS256', expiresIn: lifetimeSeconds });
}
function connectSocket(userId: number, lifetimeSeconds: number) {
  const token = tokenFor(userId, lifetimeSeconds);
  const exp = (jwt.decode(token) as { exp: number }).exp;
  const s = new FakeSocket();
  s.data = { userId, tokenExpiresAtMs: exp * 1000 };
  registerReauthHandlers(noIo, asSocket(s));
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('registerReauthHandlers — expiry timers', () => {
  it('emits token_expiring `lead` before expiry, and not a moment earlier', () => {
    const lead = env.tokenExpiryWarningLeadMs; // 60s by default
    const s = connectSocket(1, 15 * 60);

    vi.advanceTimersByTime(15 * 60_000 - lead - 2_000);
    expect(s.sent).toHaveLength(0);

    vi.advanceTimersByTime(3_000);
    expect(s.sent.map((e) => e.event)).toEqual(['token_expiring']);
  });

  it('a client that never reauths is told why, THEN disconnected, at expiry', () => {
    const s = connectSocket(1, 120);
    vi.advanceTimersByTime(119_000);
    expect(s.disconnected).toBe(false);

    vi.advanceTimersByTime(2_000);
    expect(s.disconnected).toBe(true);
    // Reason first: the client can't tell "token ran out" from "kicked"
    // using Socket.IO's own disconnect reason alone.
    expect(s.sent.map((e) => e.event)).toEqual(['token_expiring', 'disconnect_reason']);
    expect(s.sent[1].payload).toEqual({ reason: 'token_expired' });
  });

  it('never warns earlier than the midpoint of a short-lived token (no refresh hot-loop)', () => {
    // 20s of life with a 60s lead would be "already expiring" at birth.
    const s = connectSocket(1, 20);
    vi.advanceTimersByTime(8_000);
    expect(s.sent).toHaveLength(0);
    vi.advanceTimersByTime(3_000); // past the ~10s midpoint
    expect(s.sent.map((e) => e.event)).toEqual(['token_expiring']);
  });

  it('a socket that disconnects leaves no live timers behind', () => {
    const s = connectSocket(1, 120);
    s.emit('disconnect');
    vi.advanceTimersByTime(10 * 60_000);
    expect(s.sent).toHaveLength(0);
    expect(s.disconnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('registerReauthHandlers — reauth', () => {
  it('a valid token for the same user moves BOTH timers forward; the connection survives the old expiry', async () => {
    const s = connectSocket(1, 120);
    vi.advanceTimersByTime(90_000); // inside the warning window, old token ~30s from death

    const fresh = tokenFor(1, 120); // new token: now + 120s
    const result = await s.clientEmit('reauth', { token: fresh });
    expect(result.ok).toBe(true);
    expect(result.expiresInMs).toBeGreaterThan(100_000);

    s.sent.length = 0;
    vi.advanceTimersByTime(60_000); // t=150s: well past the OLD expiry (t=120s)
    expect(s.disconnected).toBe(false);

    vi.advanceTimersByTime(60_000); // t=210s: past the NEW expiry (t=90+120)
    expect(s.disconnected).toBe(true);
  });

  it('after reauth the NEXT token_expiring is scheduled off the new expiry, not the old one', async () => {
    const s = connectSocket(1, 15 * 60);
    vi.advanceTimersByTime(14 * 60_000);
    await s.clientEmit('reauth', { token: tokenFor(1, 15 * 60) });
    s.sent.length = 0;

    vi.advanceTimersByTime(60_000); // old warning time + old expiry would both have fired by now
    expect(s.sent).toHaveLength(0);
    expect(s.disconnected).toBe(false);
  });

  it("a valid token for a DIFFERENT user is refused and the socket is closed (identity can't be swapped in place)", async () => {
    const s = connectSocket(1, 300);
    const result = await s.clientEmit('reauth', { token: tokenFor(2, 300) });

    expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(s.disconnected).toBe(true);
  });

  it('a garbage token is refused WITHOUT disconnecting, and the original expiry still applies', async () => {
    const s = connectSocket(1, 120);
    const result = await s.clientEmit('reauth', { token: 'not-a-jwt' });

    expect(result).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(s.disconnected).toBe(false);

    vi.advanceTimersByTime(121_000);
    expect(s.disconnected).toBe(true); // backstop intact
  });

  it('an expired token is refused like any other invalid one', async () => {
    const s = connectSocket(1, 300);
    const expired = jwt.sign({ sub: '1', exp: Math.floor(Date.now() / 1000) - 10 }, env.jwtSecret, { algorithm: 'HS256' });
    expect(await s.clientEmit('reauth', { token: expired })).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(s.disconnected).toBe(false);
  });

  it('missing / non-string payloads are refused, not crashed on', async () => {
    const s = connectSocket(1, 300);
    expect(await s.clientEmit('reauth', undefined)).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(await s.clientEmit('reauth', { token: 42 })).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(await s.clientEmit('reauth', { token: '' })).toEqual({ ok: false, code: 'UNAUTHORIZED' });
  });
});
