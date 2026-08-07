// @vitest-environment jsdom
/**
 * Phase 6 exercises B1, H1, H2, M2 — real backend, real shipped api/*
 * modules, real DOM rendering where the exercise needs it (M2, H2).
 *
 * One thing Node's fetch does NOT do that a browser does: persist cookies
 * across requests. `credentials: 'include'` in api/client.ts assumes a
 * browser's cookie jar exists — in Node it's a silent no-op, since there
 * is no jar. B1 and H2 both depend on the httpOnly refresh cookie actually
 * round-tripping, so this file installs a tiny cookie-jar shim around
 * globalThis.fetch before any api/* module runs. This is a shim around the
 * TEST HARNESS, not the application code under test — api/client.ts is
 * untouched.
 *
 * Run: npm run test:integration (server must already be running)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { createElement, useState, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

let realFetch: typeof fetch;

beforeEach(async () => {
  const res = await fetch(`${API_BASE}/health`).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(`Backend not reachable at ${API_BASE}/health — start it first (npm run dev in server/).`);
  }
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

/**
 * Installs a fetch wrapper with a private cookie jar (mimics one browser
 * origin's cookie store) and a call log (every URL requested, in order).
 * Multiple "sessions" installed with the SAME jar instance behave like two
 * tabs of the same browser profile — separate JS module state, shared
 * cookies, which is exactly what two real tabs are.
 */
function installCookieJarFetch() {
  const jar = new Map<string, string>();
  const callLog: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    callLog.push(url);

    const headers = new Headers(init.headers);
    if (jar.size > 0) {
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      headers.set('Cookie', cookieHeader);
    }

    const res = await realFetch(input, { ...init, headers });

    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    return res;
  }) as typeof fetch;

  return { callLog, jar, rawFetch: realFetch };
}

async function newSession() {
  const { vi } = await import('vitest');
  const [auth, rooms, messages, cursor, client, tokenStore] = await Promise.all([
    import('../api/auth'),
    import('../api/rooms'),
    import('../api/messages'),
    import('../api/cursor'),
    import('../api/client'),
    import('../api/tokenStore'),
  ]);
  vi.resetModules();
  return { auth, rooms, messages, cursor, client, tokenStore };
}

describe('B1 — single-flight refresh dedup', () => {
  it('5 concurrent calls to refreshAccessToken() share exactly ONE /auth/refresh network call', async () => {
    // Isolating the actual property B1 asks about: does the module-level
    // `refreshPromise` in api/client.ts really dedupe concurrent callers.
    // Deliberately NOT routed through 5 concurrent apiFetch()/DB-backed
    // requests — that would conflate this with PGlite's single-connection
    // ceiling (the same wall every other true-concurrency exercise in this
    // project hits), which is a sandbox substitute-DB limitation, not
    // anything to do with single-flight dedup. Calling refreshAccessToken()
    // directly, 5 times at once, exercises exactly the dedup logic and
    // nothing else — there's genuinely only ONE request in flight either
    // way, so there's nothing for the substitute DB to collide on.
    const { callLog } = installCookieJarFetch();
    const suffix = Date.now();
    const session = await newSession();

    await session.auth.register(`b1user${suffix}`, `b1user-${suffix}@example.com`, 'correcthorsebattery');
    callLog.length = 0; // only count what happens from here on

    const results = await Promise.all([
      session.client.refreshAccessToken(),
      session.client.refreshAccessToken(),
      session.client.refreshAccessToken(),
      session.client.refreshAccessToken(),
      session.client.refreshAccessToken(),
    ]);

    // All 5 callers got the SAME outcome, from the SAME shared promise.
    expect(results).toEqual([true, true, true, true, true]);

    const refreshCalls = callLog.filter((url) => url.includes('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1); // NOT 5 — this is the whole point of the exercise

    // Proof the token that came out of that one shared call is real and
    // usable: one single, sequential, authenticated request succeeds.
    const rooms = await session.rooms.listMyRooms();
    expect(Array.isArray(rooms)).toBe(true);
  }, 15000);
});

describe('H1 — two tabs of the SAME logged-in user', () => {
  it("tab A's own poll re-discovering its own just-sent message never duplicates it", async () => {
    installCookieJarFetch();
    const suffix = Date.now();
    const email = `h1user-${suffix}@example.com`;
    const password = 'correcthorsebattery';

    const tabA = await newSession();
    await tabA.auth.register(`h1user${suffix}`, email, password);

    const tabB = await newSession();
    await tabB.auth.login(email, password); // same account, independent session/module state

    const room = await tabA.rooms.createRoom(`H1 room ${suffix}`);

    // What ChatRoomPage's handleSend actually does: optimistic bubble,
    // then reconcile with the direct POST response.
    const clientMessageId = crypto.randomUUID();
    const confirmed = await tabA.messages.sendMessage(room.id, 'from tab A', clientMessageId);
    // Seed state as if the optimistic bubble was already reconciled with
    // the direct POST response, exactly like ChatRoomPage.handleSend does.
    let tabAMessages: (typeof confirmed)[] = [confirmed];

    // Now tab A's OWN poll loop ticks and re-fetches — the message it just
    // sent is now sitting in the DB and will come back through THIS path
    // too. Feed it through the real mergeMessages the same way ChatRoomPage
    // does and confirm it does not appear twice.
    const { mergeMessages } = await import('../utils/mergeMessages');
    const page = await tabA.messages.pollMessages(room.id, tabA.cursor.encodeCursor(0));
    tabAMessages = mergeMessages(tabAMessages, page.messages);

    const matches = tabAMessages.filter((m) => m.client_message_id === clientMessageId);
    expect(matches).toHaveLength(1);

    // Tab B (a totally separate module instance / session, same account)
    // polling independently sees the same message, correctly attributed
    // to the account's own username via the sender_username JOIN — not
    // "undefined" just because it's a second session of the sender.
    const tabBPage = await tabB.messages.pollMessages(room.id, tabB.cursor.encodeCursor(0));
    expect(tabBPage.messages).toHaveLength(1);
    expect(tabBPage.messages[0].sender_username).toBe(`h1user${suffix}`);
  }, 15000);
});

describe('H2 — reuse detection mid-session correctly ends up logged out', () => {
  it('a refresh attempt after the token family is revoked returns false and clears the access token', async () => {
    const { jar, rawFetch } = installCookieJarFetch();
    const suffix = Date.now();
    const session = await newSession();

    await session.auth.register(`h2user${suffix}`, `h2user-${suffix}@example.com`, 'correcthorsebattery');
    const originalRefreshToken = jar.get('refresh_token');
    expect(originalRefreshToken).toBeTruthy();

    // One legitimate rotation — jar now tracks the NEW token.
    const firstRefreshOk = await session.client.refreshAccessToken();
    expect(firstRefreshOk).toBe(true);
    const rotatedToken = jar.get('refresh_token');
    expect(rotatedToken).not.toBe(originalRefreshToken);

    // Replay the ORIGINAL (now-stale) token directly — this is exactly
    // what refresh-race-test.mjs and Phase 2's exercises proved triggers
    // reuse detection: the whole token family gets revoked, including the
    // currently-valid rotated token the jar is holding right now.
    const reuseRes = await rawFetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `refresh_token=${originalRefreshToken}` },
    });
    expect(reuseRes.status).toBe(401);

    // Now the session's OWN next refresh attempt — using the rotated
    // token, which was never itself misused — should ALSO fail, because
    // the whole family got revoked as collateral.
    const secondRefreshOk = await session.client.refreshAccessToken();
    expect(secondRefreshOk).toBe(false);
    expect(session.tokenStore.getAccessToken()).toBeNull();

    // Close the loop at the UI level, not just the network level: mount a
    // real component subscribed to the token store (the same mechanism
    // AuthContext.tsx uses) and confirm it reactively reflects "logged out"
    // the moment the token store goes null — the actual observable
    // consequence a user would see.
    function Probe() {
      const [loggedIn, setLoggedIn] = useState(session.tokenStore.getAccessToken() !== null);
      useEffect(
        () => session.tokenStore.onAccessTokenChange((t: string | null) => setLoggedIn(t !== null)),
        []
      );
      return createElement('div', { 'data-testid': 'status' }, loggedIn ? 'logged-in' : 'logged-out');
    }

    let container: ReturnType<typeof render>;
    act(() => {
      container = render(createElement(Probe));
    });
    expect(container!.getByTestId('status').textContent).toBe('logged-out');
  }, 15000);
});

describe('M2 — XSS: message bodies are stored verbatim but never executed on render', () => {
  it('a script-tag payload round-trips as inert text through the real API and the real MessageItem component', async () => {
    installCookieJarFetch();
    const suffix = Date.now();
    const session = await newSession();
    await session.auth.register(`m2user${suffix}`, `m2user-${suffix}@example.com`, 'correcthorsebattery');
    const room = await session.rooms.createRoom(`M2 room ${suffix}`);

    const payload = '<script>window.__xss_fired = true;</script><img src=x onerror="window.__xss_fired = true">';
    const sent = await session.messages.sendMessage(room.id, payload, crypto.randomUUID());

    // The server never sanitizes or rejects this — that's not its job,
    // and it shouldn't silently rewrite user content. It's stored and
    // returned byte-for-byte.
    expect(sent.body).toBe(payload);

    const { MessageItem } = await import('../components/MessageItem');
    (window as unknown as { __xss_fired?: boolean }).__xss_fired = false;

    let container: ReturnType<typeof render>;
    act(() => {
      container = render(
        createElement(MessageItem, {
          message: sent,
          isOwn: true,
          ownUsername: `m2user${suffix}`,
        })
      );
    });

    // The literal text is visible in the rendered DOM...
    expect(container!.container.textContent).toContain('<script>');
    // ...but it was never parsed as an element — {message.body} in JSX
    // goes through React's text-child escaping, equivalent to
    // `textContent =`, never `innerHTML =`.
    expect(container!.container.querySelectorAll('script')).toHaveLength(0);
    expect(container!.container.querySelectorAll('img')).toHaveLength(0);
    // And neither payload actually executed.
    expect((window as unknown as { __xss_fired?: boolean }).__xss_fired).toBe(false);
  }, 15000);
});
