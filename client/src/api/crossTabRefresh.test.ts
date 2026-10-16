import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Phase 15 exercises H2 + H3 against the REAL api/client.ts.
 *
 * "Two tabs" = two independent copies of the module (vi.resetModules() +
 * dynamic import): each has its own in-memory token and its own single-flight
 * promise, exactly like two browser tabs — and they share only what real tabs
 * share: one cookie jar (below) and one Web Locks manager (below).
 */

type TabApi = typeof import('./client');
type TokenApi = typeof import('./tokenStore');

async function openTab(): Promise<{ api: TabApi; tokens: TokenApi }> {
  vi.resetModules();
  const api = await import('./client');
  const tokens = await import('./tokenStore');
  return { api, tokens };
}

/** A rotating-refresh-token server with the same reuse rule as Phase 2:
 * presenting a token that was already rotated away revokes the whole family. */
function makeServerAndJar(latencyMs = 50) {
  const jar = { cookie: 'c0' };
  const server = { current: 'c0', used: new Set<string>(), revoked: false, seq: 0, hits: [] as string[] };
  const fetchStub = vi.fn(async () => {
    const sent = jar.cookie; // the browser attaches the cookie when the request is SENT
    await new Promise((r) => setTimeout(r, latencyMs)); // network
    server.hits.push(sent);
    const reply = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body });
    if (server.revoked) return reply(401);
    if (sent === server.current) {
      server.used.add(sent);
      server.seq += 1;
      server.current = `c${server.seq}`;
      jar.cookie = server.current; // Set-Cookie lands when the response does
      return reply(200, { accessToken: `access-${server.seq}` });
    }
    if (server.used.has(sent)) {
      server.revoked = true; // REUSE DETECTED -> family revoked, winner's new token dies too
      return reply(401);
    }
    return reply(401);
  });
  return { jar, server, fetchStub };
}

/** Minimal Web Locks: FIFO mutual exclusion per name, shared by every "tab". */
function makeLockManager() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request: <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

function setLocks(value: unknown) {
  Object.defineProperty(globalThis.navigator, 'locks', { value, configurable: true });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocks(undefined);
});

describe('H2 — two tabs refreshing in the same millisecond', () => {
  it('WITHOUT a cross-tab lock: the second request looks like token reuse and the whole family dies', async () => {
    setLocks(undefined);
    const { server, fetchStub } = makeServerAndJar();
    vi.stubGlobal('fetch', fetchStub);
    const tabA = await openTab();
    const tabB = await openTab();

    const pA = tabA.api.refreshAccessTokenOutcome();
    const pB = tabB.api.refreshAccessTokenOutcome();
    await vi.advanceTimersByTimeAsync(200);
    const outcomes = await Promise.all([pA, pB]);

    expect(server.hits).toEqual(['c0', 'c0']); // both presented the SAME cookie
    expect(outcomes.sort()).toEqual(['dead', 'ok']);
    expect(server.revoked).toBe(true);

    // The collateral damage: the "winner" is logged out on its very next refresh.
    const again = tabA.api.refreshAccessTokenOutcome();
    await vi.advanceTimersByTimeAsync(200);
    expect(await again).toBe('dead');
  });

  it('WITH the lock: the second tab waits, then presents the ROTATED cookie — both succeed, nothing is revoked', async () => {
    setLocks(makeLockManager());
    const { server, fetchStub } = makeServerAndJar();
    vi.stubGlobal('fetch', fetchStub);
    const tabA = await openTab();
    const tabB = await openTab();

    const pA = tabA.api.refreshAccessTokenOutcome();
    const pB = tabB.api.refreshAccessTokenOutcome();
    await vi.advanceTimersByTimeAsync(300);
    const outcomes = await Promise.all([pA, pB]);

    expect(outcomes).toEqual(['ok', 'ok']);
    expect(server.hits).toEqual(['c0', 'c1']); // sequential: c0 rotated to c1 BEFORE tab B sent
    expect(server.revoked).toBe(false);
    expect(tabA.tokens.getAccessToken()).toBe('access-1');
    expect(tabB.tokens.getAccessToken()).toBe('access-2');
  });

  it('inside one tab, single-flight still collapses concurrent callers into ONE request', async () => {
    setLocks(makeLockManager());
    const { fetchStub } = makeServerAndJar();
    vi.stubGlobal('fetch', fetchStub);
    const tab = await openTab();

    const calls = [tab.api.refreshAccessToken(), tab.api.refreshAccessToken(), tab.api.refreshAccessTokenOutcome()];
    await vi.advanceTimersByTimeAsync(200);
    expect(await Promise.all(calls)).toEqual([true, true, 'ok']);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('H3 — the three outcomes', () => {
  async function tabWithResponse(respond: () => Promise<unknown>) {
    vi.stubGlobal('fetch', vi.fn(respond));
    const tab = await openTab();
    tab.tokens.setAccessToken('still-valid-token');
    return tab;
  }

  it('a 500 is TRANSIENT and leaves the (still valid) access token alone', async () => {
    const tab = await tabWithResponse(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await tab.api.refreshAccessTokenOutcome()).toBe('transient');
    expect(tab.tokens.getAccessToken()).toBe('still-valid-token');
  });

  it('a 429 is TRANSIENT too', async () => {
    const tab = await tabWithResponse(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(await tab.api.refreshAccessTokenOutcome()).toBe('transient');
  });

  it('no response at all (network down) is TRANSIENT, token kept', async () => {
    const tab = await tabWithResponse(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await tab.api.refreshAccessTokenOutcome()).toBe('transient');
    expect(tab.tokens.getAccessToken()).toBe('still-valid-token');
  });

  it('a 401 is DEAD and clears the token — the session really is over', async () => {
    const tab = await tabWithResponse(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(await tab.api.refreshAccessTokenOutcome()).toBe('dead');
    expect(tab.tokens.getAccessToken()).toBeNull();
  });

  it('the boolean wrapper is true only for ok (callers that only need "do I have a fresh token?" are unchanged)', async () => {
    const tab = await tabWithResponse(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    expect(await tab.api.refreshAccessToken()).toBe(false);
  });
});
