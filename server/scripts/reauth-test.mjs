#!/usr/bin/env node
/**
 * Phase 15, part 2 — verifies "simulating an access-token expiry
 * mid-connection triggers token_expiring -> client reauth -> connection
 * survives with no gap in delivery" against a running server.
 *
 * The CLIENT under test is the real client/src/realtime/connectionLifecycle.ts,
 * imported unmodified (hence `node --import tsx`): this proves the module
 * that ships, not a re-implementation of it.
 *
 * Expiry is "simulated" by making it fast — start the server with a short
 * token life:
 *
 *   ACCESS_TOKEN_TTL=6s TOKEN_EXPIRY_WARNING_LEAD_MS=3000 npm run dev
 *   node --import tsx scripts/reauth-test.mjs
 *
 * Scenarios:
 *   1. SURVIVAL. A real-lifecycle client sits in a room for ~16s (more than
 *      two full token lifetimes) while another user sends a message every
 *      ~600ms. Same socket id throughout, zero disconnects, at least two
 *      token_expiring -> reauth round trips, and every message delivered
 *      with contiguous sequence numbers (no gap, no duplicate).
 *   2. CONTROL. A client that IGNORES token_expiring is warned ~3s before
 *      exp, then force-disconnected at ~exp with disconnect_reason
 *      token_expired. Proves scenario 1 survived BECAUSE of the reauth,
 *      not because expiry isn't enforced.
 *   3. IDENTITY SWAP. reauth with a valid token for a DIFFERENT user is
 *      refused (FORBIDDEN) and the socket is closed.
 *   4. GARBAGE. reauth with a junk token -> UNAUTHORIZED, socket stays up.
 *   5. STALE TOKEN ON CONNECT. Reconnecting with the (now expired) token
 *      from scenario 2 is rejected at the handshake; the lifecycle
 *      refreshes and connects again on its own.
 *
 * Sandbox note: PGlite is single-connection, so the script staggers
 * connections and (with SERIALIZE_DB=1) takes turns on DB-touching calls; on
 * real Postgres none of that is needed. See SERIALIZE_DB below.
 */
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { attachConnectionLifecycle } from '../../client/src/realtime/connectionLifecycle.ts';

const BASE_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SANDBOX-ONLY. PGlite hosts exactly one database connection, so two
// overlapping transactions (a /auth/refresh rotation landing on top of a
// send_message insert) make one of them die with "Connection terminated
// unexpectedly" — observed for real while writing this script: 3 of ~10
// refreshes failed that way, and a refresh that fails means no reauth.
// SERIALIZE_DB=1 makes this script take turns for the DB-touching things IT
// initiates (refreshes, bob's sends). Real Postgres has a connection pool and
// needs none of this: leave it unset there.
const SERIALIZE_DB = process.env.SERIALIZE_DB === '1';
let dbChain = Promise.resolve();
function withDb(fn) {
  if (!SERIALIZE_DB) return fn();
  const run = dbChain.then(fn, fn);
  dbChain = run.catch(() => {});
  return run;
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS — ${label}`);
  else {
    console.error(`  FAIL — ${label}${detail ? ` (${detail})` : ''}`);
    failures++;
  }
}

function jwtExpMs(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000;
}

function extractCookie(setCookieHeader, name) {
  const match = new RegExp(`${name}=([^;]+)`).exec(setCookieHeader ?? '');
  return match?.[1];
}

/** A session = what a browser would hold: an access token in memory, a refresh cookie in the jar. */
async function registerSession(label) {
  const suffix = Date.now() + Math.random().toString(36).slice(2);
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `${label}${suffix}`.slice(0, 30),
      email: `${label}-${suffix}@example.com`,
      password: 'correcthorsebattery',
    }),
  });
  if (!res.ok) throw new Error(`register failed ${res.status} ${await res.text()}`);
  const body = await res.json();
  return {
    user: body.user,
    token: body.accessToken,
    cookie: extractCookie(res.headers.get('set-cookie'), 'refresh_token'),
    refreshes: 0,
  };
}

/** Mirrors api/client.ts's refreshAccessToken: rotate the cookie, store the new access token. */
async function refreshSession(s) {
  return withDb(() => refreshSessionNow(s));
}
async function refreshSessionNow(s) {
  const res = await fetch(`${BASE_URL}/auth/refresh`, { method: 'POST', headers: { Cookie: `refresh_token=${s.cookie}` } });
  if (!res.ok) return false;
  const newCookie = extractCookie(res.headers.get('set-cookie'), 'refresh_token');
  const body = await res.json();
  s.token = body.accessToken;
  if (newCookie) s.cookie = newCookie;
  s.refreshes += 1;
  return true;
}

const authed = (s, extra = {}) => ({ ...extra, Authorization: `Bearer ${s.token}` });

async function createRoom(s, name) {
  const res = await fetch(`${BASE_URL}/rooms`, { method: 'POST', headers: authed(s, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`create room failed ${res.status}`);
  return res.json();
}
async function joinRoomHttp(s, roomId) {
  const res = await fetch(`${BASE_URL}/rooms/${roomId}/join`, { method: 'POST', headers: authed(s) });
  if (!res.ok) throw new Error(`HTTP join failed ${res.status}`);
}

/** Connect the way the real client does: token read lazily, per (re)connect attempt. */
function connect(session, { withLifecycle, reconnection = false } = {}) {
  const socket = ioClient(BASE_URL, { auth: (cb) => cb({ token: session.token }), reconnection, timeout: 5000 });
  const log = { disconnects: [], expiring: [], reasons: [], connectErrors: [], connects: 0, t0: Date.now() };
  socket.on('disconnect', (r) => log.disconnects.push({ reason: r, at: Date.now() }));
  socket.on('token_expiring', (p) => log.expiring.push({ ...p, at: Date.now() }));
  socket.on('disconnect_reason', (p) => log.reasons.push({ ...p, at: Date.now() }));
  socket.on('connect_error', (e) => log.connectErrors.push(e.message));
  socket.on('connect', () => log.connects++);
  let detach = () => {};
  if (withLifecycle) {
    detach = attachConnectionLifecycle(
      socket,
      { refreshAccessToken: () => refreshSession(session), getAccessToken: () => session.token, flushOutbox: () => {} },
      { reauthJitterMaxMs: 500 },
    );
  }
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({ socket, log, detach }));
    socket.once('connect_error', (e) => (withLifecycle ? resolve({ socket, log, detach }) : reject(e)));
  });
}

function joinRoom(socket, roomId) {
  return new Promise((resolve, reject) => {
    socket.once('joined_room', resolve);
    socket.once('error', reject);
    socket.emit('join_room', { roomId });
  });
}

function emitReauth(socket, token) {
  return new Promise((resolve) => socket.timeout(5000).emit('reauth', { token }, (err, res) => resolve(err ? { timedOut: true } : res)));
}

async function main() {
  console.log(`Testing against ${BASE_URL}`);
  console.log('(expects the server to be running with ACCESS_TOKEN_TTL=6s TOKEN_EXPIRY_WARNING_LEAD_MS=3000)\n');

  // ------------------------------------------------------------------ 1
  console.log('1. A real-lifecycle client survives >2 token lifetimes with no gap in delivery');
  const alice = await registerSession('rea-alice');
  await sleep(80);
  const bob = await registerSession('rea-bob');
  await sleep(80);
  const room = await createRoom(alice, `reauth-${Date.now()}`);
  await sleep(80);
  await joinRoomHttp(bob, room.id);
  await sleep(80);

  const ttlMs = jwtExpMs(alice.token) - Date.now();
  check(`server is running with a short token life (alice's token lives ~${Math.round(ttlMs / 1000)}s; need <= 8s)`, ttlMs <= 8000, 'start the server with ACCESS_TOKEN_TTL=6s');

  // Both users run the REAL lifecycle: bob's token expires every 6s too.
  const a = await connect(alice, { withLifecycle: true });
  await sleep(80);
  await joinRoom(a.socket, room.id);
  await sleep(80);
  const b = await connect(bob, { withLifecycle: true });
  await sleep(80);
  await joinRoom(b.socket, room.id);
  const aliceSocketId = a.socket.id;
  const bobSocketId = b.socket.id;
  const received = [];
  a.socket.on('new_message', (m) => received.push(m));
  const acked = [];
  b.socket.on('message_ack', (m) => acked.push(m));
  await sleep(500);

  // bob sends over his socket every 600ms for ~16s; alice must see each one live.
  const sendLoopEnds = Date.now() + 16_000;
  let sentCount = 0;
  while (Date.now() < sendLoopEnds) {
    const clientMessageId = randomUUID();
    const body = `msg-${sentCount++}`;
    await withDb(
      () =>
        new Promise((resolve) => {
          const onAck = (m) => {
            if (m.client_message_id === clientMessageId) {
              b.socket.off('message_ack', onAck);
              resolve();
            }
          };
          b.socket.on('message_ack', onAck);
          b.socket.emit('send_message', { roomId: room.id, body, clientMessageId });
          setTimeout(() => {
            b.socket.off('message_ack', onAck);
            resolve();
          }, 3000);
        }),
    );
    await sleep(600);
  }
  await sleep(900);

  const seqs = received.map((m) => Number(m.sequence_number));
  const contiguous = seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1);
  const history = await fetch(`${BASE_URL}/rooms/${room.id}/messages?limit=100`, { headers: authed(alice) }).then((r) => r.json());
  const persistedSeqs = history.messages.map((m) => Number(m.sequence_number)).sort((x, y) => x - y);
  check(`alice's socket is still connected with the SAME socket id after ${(Date.now() - a.log.t0) / 1000 | 0}s`, a.socket.connected && a.socket.id === aliceSocketId);
  check('zero disconnects, zero reconnects — for BOTH clients', a.log.disconnects.length === 0 && a.log.connects === 1 && b.log.disconnects.length === 0 && b.log.connects === 1 && b.socket.id === bobSocketId, JSON.stringify([a.log.disconnects, b.log.disconnects]));
  check(`at least 2 token_expiring -> reauth round trips happened (saw ${a.log.expiring.length} warnings, ${alice.refreshes} refreshes)`, a.log.expiring.length >= 2 && alice.refreshes >= 2);
  check(`every message bob sent was acked (${acked.length} of ${sentCount}) and delivered live to alice (${received.length})`, sentCount >= 20 && acked.length === sentCount && received.length === sentCount);
  check('what alice received live == what the database holds (nothing missed, nothing extra)', seqs.join(',') === persistedSeqs.join(','), `live=${seqs.length} db=${persistedSeqs.length}`);
  check('sequence numbers are contiguous — no gap, no duplicate', contiguous && new Set(seqs).size === seqs.length, seqs.join(','));
  check('alice has a fresh token now (exp is in the future)', jwtExpMs(alice.token) > Date.now());
  a.detach();
  b.detach();
  a.socket.close();
  b.socket.close();

  // ------------------------------------------------------------------ 2
  console.log('\n2. Control: a client that ignores token_expiring is warned, then force-disconnected at exp');
  const ignorer = await registerSession('rea-ign');
  const expMs = jwtExpMs(ignorer.token);
  const ig = await connect(ignorer, { withLifecycle: false });
  const waitUntil = expMs + 2500;
  while (Date.now() < waitUntil && ig.log.disconnects.length === 0) await sleep(100);
  await sleep(300);
  const warn = ig.log.expiring[0];
  const reason = ig.log.reasons[0];
  const dc = ig.log.disconnects[0];
  check('got token_expiring', !!warn);
  check(`warning arrived ~3s before exp (${warn ? ((expMs - warn.at) / 1000).toFixed(1) : '?'}s before; expected 2-4s)`, warn && expMs - warn.at >= 2000 && expMs - warn.at <= 4000);
  check("got disconnect_reason {reason: 'token_expired'}", reason?.reason === 'token_expired');
  check(`disconnected with 'io server disconnect' at ~exp (${dc ? ((dc.at - expMs) / 1000).toFixed(1) : '?'}s after; expected within ±1s)`, dc?.reason === 'io server disconnect' && Math.abs(dc.at - expMs) <= 1000);
  const staleToken = ignorer.token; // expired by now; the refresh cookie is untouched

  // ------------------------------------------------------------------ 3
  console.log('\n3. reauth with ANOTHER user\'s valid token is refused and the socket is closed');
  const mallory = await registerSession('rea-mal');
  await sleep(80);
  const victim = await registerSession('rea-vic');
  await sleep(80);
  const m = await connect(mallory, { withLifecycle: false });
  const swapAck = await emitReauth(m.socket, victim.token);
  await sleep(500);
  check(`ack is {ok:false, code:'FORBIDDEN'}`, swapAck?.ok === false && swapAck?.code === 'FORBIDDEN', JSON.stringify(swapAck));
  check('mallory\'s socket was closed', !m.socket.connected && m.log.disconnects.length === 1);
  m.socket.close();

  // ------------------------------------------------------------------ 4
  console.log('\n4. reauth with a garbage token -> UNAUTHORIZED, the socket stays up');
  const gsess = await registerSession('rea-gar');
  await sleep(80);
  const g = await connect(gsess, { withLifecycle: false });
  const garbageAck = await emitReauth(g.socket, 'not.a.jwt');
  await sleep(300);
  check(`ack is {ok:false, code:'UNAUTHORIZED'}`, garbageAck?.ok === false && garbageAck?.code === 'UNAUTHORIZED', JSON.stringify(garbageAck));
  check('socket still connected (a bad token must not become a way to kick yourself — or a way to learn anything)', g.socket.connected && g.log.disconnects.length === 0);
  g.socket.close();

  // ------------------------------------------------------------------ 5
  console.log('\n5. Connecting with an EXPIRED token: handshake rejected, lifecycle refreshes and connects by itself');
  ignorer.token = staleToken;
  check('precondition: the token being presented is expired', jwtExpMs(ignorer.token) < Date.now());
  const refreshesBefore = ignorer.refreshes;
  const r = await connect(ignorer, { withLifecycle: true });
  for (let i = 0; i < 50 && !r.socket.connected; i++) await sleep(100);
  check("first attempt was rejected with 'UNAUTHORIZED'", r.log.connectErrors[0] === 'UNAUTHORIZED', JSON.stringify(r.log.connectErrors));
  check('lifecycle refreshed once and reconnected without any help', r.socket.connected && ignorer.refreshes === refreshesBefore + 1, `connected=${r.socket.connected} refreshes=${ignorer.refreshes - refreshesBefore}`);
  r.detach();
  r.socket.close();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('script crashed:', e);
  process.exit(1);
});
