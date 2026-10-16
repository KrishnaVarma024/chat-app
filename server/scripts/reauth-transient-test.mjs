#!/usr/bin/env node
/**
 * Phase 15 exercise H3 — the same mid-connection reauth as reauth-test.mjs,
 * but the first refresh attempt FAILS the way a flaky network or a 502 would.
 *
 *   A. Client given the three-way refresh (ok / dead / transient): the first
 *      attempt returns 'transient', the lifecycle waits and retries inside
 *      the time the token has left, and the socket survives the expiry —
 *      same socket id, zero disconnects.
 *   B. Control: client given only the old boolean (false == "session dead"):
 *      the same single failure ends reauth for good, the server force-closes
 *      the socket at expiry, and the client has to reconnect (new socket id).
 *
 * The failure is injected on the client side (the dependency returns it
 * without calling the server) — that is exactly the information the
 * lifecycle sees when /auth/refresh answers 5xx or never answers.
 *
 *   ACCESS_TOKEN_TTL=6s TOKEN_EXPIRY_WARNING_LEAD_MS=3000 npm run dev
 *   node --import tsx scripts/reauth-transient-test.mjs
 */
import { io as ioClient } from 'socket.io-client';
import { attachConnectionLifecycle } from '../../client/src/realtime/connectionLifecycle.ts';

const BASE_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  PASS — ${label}`);
  else {
    console.error(`  FAIL — ${label}${detail ? ` (${detail})` : ''}`);
    failures++;
  }
};
const cookieOf = (h) => /refresh_token=([^;]+)/.exec(h ?? '')?.[1];

async function registerSession(label) {
  const sfx = Date.now() + Math.random().toString(36).slice(2);
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `${label}${sfx}`.slice(0, 30), email: `${label}-${sfx}@example.com`, password: 'correcthorsebattery' }),
  });
  const body = await res.json();
  return { token: body.accessToken, cookie: cookieOf(res.headers.get('set-cookie')) };
}

async function realRefresh(s) {
  const res = await fetch(`${BASE_URL}/auth/refresh`, { method: 'POST', headers: { Cookie: `refresh_token=${s.cookie}` } });
  if (!res.ok) return false;
  s.cookie = cookieOf(res.headers.get('set-cookie')) ?? s.cookie;
  s.token = (await res.json()).accessToken;
  return true;
}

async function scenario(label, detailed) {
  const s = await registerSession(label);
  const calls = [];
  let injected = false;
  const refreshOnce = async () => {
    if (!injected) {
      injected = true;
      calls.push('injected-failure');
      return 'transient';
    }
    calls.push('real-refresh');
    return (await realRefresh(s)) ? 'ok' : 'dead';
  };
  const socket = ioClient(BASE_URL, { auth: (cb) => cb({ token: s.token }), reconnection: true, reconnectionDelay: 300 });
  const log = { connects: 0, disconnects: [], ids: [] };
  socket.on('connect', () => { log.connects++; log.ids.push(socket.id); });
  socket.on('disconnect', (r) => log.disconnects.push(r));
  const deps = detailed
    ? { refreshAccessToken: async () => (await refreshOnce()) === 'ok', refreshAccessTokenDetailed: refreshOnce, getAccessToken: () => s.token, flushOutbox: () => {} }
    : { refreshAccessToken: async () => (await refreshOnce()) === 'ok', getAccessToken: () => s.token, flushOutbox: () => {} };
  const detach = attachConnectionLifecycle(socket, deps, { reauthJitterMaxMs: 300 });
  await new Promise((r) => socket.once('connect', r));
  const firstId = socket.id;
  const exp = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).exp * 1000;
  await sleep(Math.max(0, exp - Date.now()) + 2500); // ride past the ORIGINAL token's expiry
  const result = { firstId, log, calls, socket };
  detach();
  return result;
}

console.log('A. three-way refresh: one transient failure is retried, the socket survives');
const a = await scenario('trn-a', true);
check(`refresh attempts: ${a.calls.join(' -> ')}`, a.calls[0] === 'injected-failure' && a.calls[1] === 'real-refresh');
check('same socket id, one connect, zero disconnects', a.socket.connected && a.socket.id === a.firstId && a.log.connects === 1 && a.log.disconnects.length === 0, JSON.stringify(a.log));
a.socket.close();

await sleep(300);
console.log('\nB. control, boolean refresh: the same single failure is treated as a dead session');
const b = await scenario('trn-b', false);
check(`first attempt failed and was NOT retried by the reauth path: ${b.calls.join(' -> ')} (the real refresh below is the post-disconnect recovery)`, b.calls[0] === 'injected-failure');
check("the server had to force-close the socket at expiry ('io server disconnect')", b.log.disconnects[0] === 'io server disconnect', JSON.stringify(b.log));
check('the client then reconnected, on a NEW socket id', b.socket.connected && b.log.connects >= 2 && b.socket.id !== b.firstId, JSON.stringify(b.log));
b.socket.close();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
