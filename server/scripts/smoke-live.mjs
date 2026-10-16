#!/usr/bin/env node
/**
 * Live smoke test — Phase 16's "verified for real, not assumed from local
 * testing" (ROADMAP_V2.md). Point it at a DEPLOYED server and it proves, over
 * the real internet and through the hosting platform's real proxy, that the
 * v2 realtime features work:
 *
 *   1. The server is up (and how long a cold start took — Render's free tier
 *      sleeps after 15 idle minutes).
 *   2. A client using Socket.IO's DEFAULT transports (polling first) UPGRADES
 *      to a real WebSocket. This is the new risk v2 introduced: a proxy that
 *      doesn't pass the `Upgrade` header through leaves the app "working" on
 *      long-polling forever — slower, chattier, and nothing errors. Local
 *      testing can never reveal this; only the real proxy can.
 *   3. Real-time delivery: A sends, B receives it pushed (latency printed).
 *   4. Typing indicators relay.
 *   5. Presence: B sees A come online, and — after A leaves — go offline
 *      (the real grace period, so this step takes ~10 seconds).
 *   6. Rate limiting: a flood gets a `rate_limited` notice and the
 *      connection SURVIVES.
 *   7. Reconnect + catch-up: B's connection is killed, A sends while B is
 *      gone, B reconnects by itself and receives exactly what it missed.
 *   8. Idempotent resend: re-sending a message id returns the original row.
 *
 * It creates two throwaway accounts and one throwaway room on whatever server
 * you point it at — so run it against YOUR deployment, not someone else's.
 *
 * Usage (from the server/ folder):
 *   node scripts/smoke-live.mjs https://chat-app-server-j0mr.onrender.com
 *   API_URL=https://... node scripts/smoke-live.mjs
 *
 * Deploy check (verifies SIGTERM -> server_shutdown on the platform): run
 *   node scripts/smoke-live.mjs https://... --watch-deploy
 * then trigger a deploy (push a commit, or "Manual Deploy" in the Render
 * dashboard). It holds a connection open and reports what it experiences.
 *
 * Exit code 0 = everything passed.
 */
import { io as ioClient } from 'socket.io-client';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const BASE_URL = (args.find((a) => a.startsWith('http')) ?? process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const WATCH_DEPLOY = args.includes('--watch-deploy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t0) => `${Date.now() - t0}ms`;

let failed = false;
function pass(label, detail = '') {
  console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
}
function fail(label, detail = '') {
  failed = true;
  console.error(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
}
function check(label, condition, detail = '') {
  (condition ? pass : fail)(label, detail);
  return condition;
}
function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// A client that records everything, so "wait for X" never races "X already happened".
// ---------------------------------------------------------------------------
class Client {
  constructor(name, token, opts = {}) {
    this.name = name;
    this.events = [];
    this.waiters = [];
    // DEFAULT transports on purpose (polling, then upgrade) — exactly what the real browser client does.
    this.socket = ioClient(BASE_URL, {
      auth: { token },
      forceNew: true,
      reconnection: false,
      transports: ['polling', 'websocket'], // the browser default, stated explicitly: start on long-polling, then try to upgrade
      ...opts,
    });
    // The Manager creates its engine synchronously, so we can watch the very
    // first connection's transport story from the start.
    this.transportLog = [];
    const engine = this.socket.io.engine;
    engine.on('open', () => this.transportLog.push({ at: Date.now(), kind: 'open', name: engine.transport.name }));
    engine.on('upgrade', (transport) => this.transportLog.push({ at: Date.now(), kind: 'upgrade', name: transport.name }));
    this.socket.onAny((event, ...a) => this.record(event, a[0]));
    for (const e of ['connect', 'connect_error', 'disconnect']) this.socket.on(e, (p) => this.record(e, p));
  }
  record(event, payload) {
    const entry = { event, payload, consumed: false };
    this.events.push(entry);
    const i = this.waiters.findIndex((w) => w.events.includes(event) && w.pred(payload));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      entry.consumed = true;
      w.resolve({ event, payload });
    }
  }
  /** Resolves with the first not-yet-consumed event whose name is in `events` and whose payload passes `pred`. */
  takeAny(events, pred = () => true, timeoutMs = 10_000) {
    const hit = this.events.find((e) => !e.consumed && events.includes(e.event) && pred(e.payload));
    if (hit) {
      hit.consumed = true;
      return Promise.resolve({ event: hit.event, payload: hit.payload });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.name}: timed out after ${timeoutMs}ms waiting for "${events.join('|')}"`));
      }, timeoutMs);
      this.waiters.push({ events, pred, resolve, timer });
    });
  }
  async take(event, pred = () => true, timeoutMs = 10_000) {
    return (await this.takeAny([event], pred, timeoutMs)).payload;
  }
  async connect(timeoutMs = 20_000) {
    const outcome = await this.takeAny(['connect', 'connect_error'], () => true, timeoutMs);
    if (outcome.event === 'connect_error') throw new Error(`${this.name}: handshake refused: ${outcome.payload.message}`);
  }
  async join(roomId, sinceSequence) {
    this.socket.emit('join_room', sinceSequence === undefined ? { roomId } : { roomId, sinceSequence });
    await this.take('joined_room', (p) => p.roomId === roomId);
  }
  async send(roomId, body, clientMessageId = randomUUID()) {
    this.socket.emit('send_message', { roomId, body, clientMessageId });
    return this.take('message_ack', (m) => m.client_message_id === clientMessageId);
  }
  async quiet(event, windowMs) {
    await sleep(windowMs);
    return this.events.filter((e) => !e.consumed && e.event === event).map((e) => ((e.consumed = true), e.payload));
  }
  close() {
    this.waiters.forEach((w) => clearTimeout(w.timer));
    this.socket.close();
  }
}

async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

async function registerFresh(label) {
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const r = await http('POST', '/auth/register', {
    body: { username: `smoke${label}${suffix}`.slice(0, 30), email: `smoke-${label}-${suffix}@example.com`, password: 'correcthorsebattery' },
  });
  if (r.status !== 201) throw new Error(`register ${label} failed: ${r.status} ${r.text}`);
  return { token: r.json.accessToken, id: r.json.user.id, username: r.json.user.username };
}

// ---------------------------------------------------------------------------

async function waitForServer() {
  section(`0. Server reachable  (${BASE_URL})`);
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < 150_000) {
    try {
      const r = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 200) {
        const took = Date.now() - t0;
        pass('GET /health -> 200', took > 3000 ? `cold start took ${(took / 1000).toFixed(1)}s` : ms(t0));
        return;
      }
      lastErr = `status ${r.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    process.stdout.write('  ...waiting for the server to wake up\n');
    await sleep(5000);
  }
  fail('server never became healthy', lastErr);
  process.exit(1);
}

async function main() {
  await waitForServer();

  section('1. Setup: two accounts, one room');
  const alice = await registerFresh('a');
  const bob = await registerFresh('b');
  const room = await http('POST', '/rooms', { token: alice.token, body: { name: `smoke-${Date.now()}` } });
  if (room.status !== 201) throw new Error(`create room failed: ${room.status} ${room.text}`);
  const roomId = room.json.id;
  const joined = await http('POST', `/rooms/${roomId}/join`, { token: bob.token });
  check('accounts created, room created, second user joined', joined.status === 204, `room ${roomId}`);

  section('2. WebSocket upgrade through the platform proxy');
  const b = new Client('bob', bob.token, { reconnection: true, reconnectionDelay: 300, reconnectionDelayMax: 600, randomizationFactor: 0 });
  const t0 = Date.now();
  await b.connect();
  pass('bob connected', ms(t0));
  const opened = b.transportLog.find((e) => e.kind === 'open');
  const upgradeDeadline = Date.now() + 10_000;
  while (!b.transportLog.some((e) => e.kind === 'upgrade' && e.name === 'websocket') && Date.now() < upgradeDeadline) await sleep(50);
  const upgraded = b.transportLog.find((e) => e.kind === 'upgrade' && e.name === 'websocket');
  check(
    'connection upgraded from long-polling to a real WebSocket',
    Boolean(upgraded),
    upgraded
      ? `opened on "${opened?.name}", on WebSocket ${upgraded.at - (opened?.at ?? upgraded.at)}ms later`
      : 'STILL on long-polling after 10s: the proxy is not passing the Upgrade header through. Everything will "work", just slowly.'
  );
  await b.join(roomId, 0);
  await b.take('catch_up'); // the (empty) batch for the initial join — consume it so step 7 reads ITS batch

  section('3. Presence: online');
  const a = new Client('alice', alice.token);
  await a.connect();
  const online = await b.take('presence', (p) => p.userId === alice.id && p.status === 'online', 8000).catch(() => null);
  check('bob saw alice come online', Boolean(online));
  await a.join(roomId, 0);

  section('4. Real-time delivery');
  const sentAt = Date.now();
  const ack = await a.send(roomId, 'hello from the smoke test');
  const pushed = await b.take('new_message', (m) => m.client_message_id === ack.client_message_id, 8000).catch(() => null);
  check('bob received the message pushed (no polling)', Boolean(pushed), pushed ? `end-to-end ${ms(sentAt)}` : '');
  check('push matches the ack (same row, same sequence)', pushed && pushed.sequence_number === ack.sequence_number, `sequence ${ack.sequence_number}`);

  section('5. Typing indicators');
  a.socket.emit('typing_start', { roomId });
  const typing = await b.take('typing', (p) => p.userId === alice.id, 5000).catch(() => null);
  check('bob saw alice typing', Boolean(typing));
  a.socket.emit('typing_stop', { roomId });
  check('bob saw alice stop typing', Boolean(await b.take('stopped_typing', (p) => p.userId === alice.id, 5000).catch(() => null)));

  section('6. Idempotent resend');
  const again = await a.send(roomId, 'hello from the smoke test', ack.client_message_id);
  check('resending the same client_message_id returns the ORIGINAL row', again.id === ack.id && again.sequence_number === ack.sequence_number);

  section('7. Reconnect + catch-up (kill bob\'s transport; alice sends while he is gone)');
  let lastSeq = ack.sequence_number;
  b.socket.on('new_message', (m) => (lastSeq = Math.max(lastSeq, m.sequence_number)));
  b.socket.io.engine.close(); // a network drop, from bob's side
  await b.take('disconnect', () => true, 5000);
  const missed = [];
  for (let i = 1; i <= 3; i++) missed.push((await a.send(roomId, `sent while bob was offline ${i}`)).sequence_number);
  await b.take('connect', () => true, 15_000); // reconnects by itself
  await b.join(roomId, lastSeq);
  // join() resolves on joined_room; the catch_up batch arrives just before it.
  const batch = await b.take('catch_up', () => true, 5000).catch(() => null);
  const got = batch ? batch.messages.map((m) => m.sequence_number) : [];
  check('bob auto-reconnected and caught up on exactly what he missed', JSON.stringify(got) === JSON.stringify(missed), `expected ${missed}, got ${got}`);

  section('8. Rate limiting (alice floods; the connection must survive)');
  for (let i = 0; i < 14; i++) a.socket.emit('send_message', { roomId, body: `flood ${i}`, clientMessageId: randomUUID() });
  const limited = await a.take('rate_limited', (n) => n.event === 'send_message', 8000).catch(() => null);
  check('alice got a rate_limited notice', Boolean(limited), limited ? `retry after ${limited.retryAfterSeconds}s` : '');
  await sleep(500);
  check('alice is still connected (a rate limit is not a disconnect)', a.socket.connected);

  section('9. Presence: offline (waits out the real grace period, ~7s)');
  a.close();
  const offline = await b.take('presence', (p) => p.userId === alice.id && p.status === 'offline', 20_000).catch(() => null);
  check('bob saw alice go offline after she disconnected', Boolean(offline));

  b.close();
}

async function watchDeploy() {
  section(`Watching for a deploy  (${BASE_URL})`);
  await waitForServer();
  const user = await registerFresh('w');
  const c = new Client('watcher', user.token, { reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
  await c.connect();
  console.log('  connected. NOW trigger a deploy (push a commit, or "Manual Deploy" in the Render dashboard).');
  console.log('  Watching for up to 10 minutes. Ctrl-C to stop.\n');
  const t0 = Date.now();
  const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
  c.socket.on('server_shutdown', (ack) => {
    console.log(`  ${stamp()} server_shutdown RECEIVED  <- SIGTERM reached your process, and it told us`);
    if (typeof ack === 'function') ack();
  });
  c.socket.on('disconnect', (reason) => console.log(`  ${stamp()} disconnected (${reason})`));
  c.socket.on('connect', () => console.log(`  ${stamp()} connected`));
  c.socket.io.on('reconnect_attempt', (n) => console.log(`  ${stamp()} reconnect attempt #${n}`));
  c.socket.io.on('reconnect_error', (e) => console.log(`  ${stamp()} reconnect error: ${e.message}`));
  await sleep(10 * 60_000);
}

(WATCH_DEPLOY ? watchDeploy() : main())
  .then(() => {
    if (WATCH_DEPLOY) process.exit(0);
    console.log(failed || process.exitCode ? '\nSMOKE TEST FAILED' : '\nALL SMOKE CHECKS PASSED');
    process.exit(failed || process.exitCode ? 1 : 0);
  })
  .catch((err) => {
    console.error(`\nSMOKE TEST ERRORED: ${err.message}`);
    process.exit(1);
  });
