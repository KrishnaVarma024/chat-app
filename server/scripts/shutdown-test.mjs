#!/usr/bin/env node
/**
 * Phase 15, part 3 — verifies "sending SIGTERM to the process results in
 * connected clients reconnecting immediately rather than waiting out a
 * backoff delay" against a REAL server process.
 *
 * Unlike the other scripts this one spawns the server itself, because the
 * thing under test is the process lifecycle: it has to be able to send a
 * real SIGTERM to a real pid, watch the real exit code, and start a
 * replacement. The clients run the real client/src/realtime/connectionLifecycle.ts
 * (hence `node --import tsx`) with the same reconnection settings as
 * client/src/realtime/socket.ts.
 *
 *   1. SIGTERM server A (two clients connected). Measure, per client, the
 *      time from `disconnect` to the FIRST reconnect attempt: expected
 *      ~0ms (< 250ms) because the lifecycle saw `server_shutdown` first.
 *      Also: both clients received and acked the notice; the server's own
 *      log says acked=2, no timeout; the process exits with code 0.
 *   2. Start server B on the same port. The clients reconnect on their own,
 *      and a join_room on the new connection works.
 *   3. CONTROL: SIGKILL server B (no notice possible). The same clients'
 *      first reconnect attempt now waits out the ordinary backoff
 *      (1s x random 0.5-1.5 => >= 400ms with margin). Without this the
 *      "immediate" in (1) could just be the library being fast.
 *
 * Needs: the database from DATABASE_URL, plus JWT_SECRET etc. in the
 * environment, exactly like `npm run dev`. Run from the server/ directory:
 *
 *   node --import tsx scripts/shutdown-test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { attachConnectionLifecycle } from '../../client/src/realtime/connectionLifecycle.ts';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHUTDOWN_TEST_PORT ?? 4100);
const BASE_URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS — ${label}`);
  else {
    console.error(`  FAIL — ${label}${detail ? ` (${detail})` : ''}`);
    failures++;
  }
}

/** Spawn the real server entrypoint; collect its stdout for log assertions. */
function startServer(name) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: process.env.NODE_ENV ?? 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = { name, child, lines: [], exited: null, exitCode: undefined, exitSignal: undefined };
  handle.exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      handle.exitCode = code;
      handle.exitSignal = signal;
      resolve({ code, signal });
    });
  });
  const onData = (buf) => handle.lines.push(...buf.toString().split('\n').filter(Boolean));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return handle;
}

async function waitHealthy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function registerSession(label) {
  const suffix = Date.now() + Math.random().toString(36).slice(2);
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `${label}${suffix}`.slice(0, 30), email: `${label}-${suffix}@example.com`, password: 'correcthorsebattery' }),
  });
  if (!res.ok) throw new Error(`register failed ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { token: body.accessToken };
}

/** A client wired exactly like client/src/realtime/socket.ts, plus timing probes. */
function makeClient(session, label) {
  const socket = ioClient(BASE_URL, {
    auth: (cb) => cb({ token: session.token }),
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    reconnectionAttempts: Infinity,
  });
  const probe = { label, noticeAt: null, disconnectAt: null, disconnectReason: null, firstAttemptAt: null, firstAttemptErrorAt: null, connectedIds: [] };
  socket.on('server_shutdown', () => (probe.noticeAt = Date.now()));
  socket.on('connect', () => probe.connectedIds.push(socket.id));
  socket.on('disconnect', (reason) => {
    probe.disconnectAt = Date.now();
    probe.disconnectReason = reason;
    probe.firstAttemptAt = null;
    probe.firstAttemptErrorAt = null;
  });
  socket.io.on('reconnect_attempt', () => {
    if (probe.disconnectAt && probe.firstAttemptAt === null) probe.firstAttemptAt = Date.now();
  });
  socket.io.on('reconnect_error', () => {
    if (probe.disconnectAt && probe.firstAttemptErrorAt === null) probe.firstAttemptErrorAt = Date.now();
  });
  const detach = attachConnectionLifecycle(
    socket,
    { refreshAccessToken: async () => false, getAccessToken: () => session.token, flushOutbox: () => {} },
    {},
  );
  return { socket, probe, detach, session };
}

function waitConnected(client, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    if (client.socket.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), timeoutMs);
    client.socket.once('connect', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function joinRoomEvent(socket, roomId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    socket.once('joined_room', () => {
      clearTimeout(t);
      resolve(true);
    });
    socket.emit('join_room', { roomId });
  });
}

const delayOf = (p) => (p.firstAttemptAt && p.disconnectAt ? p.firstAttemptAt - p.disconnectAt : null);

async function main() {
  console.log('Starting server A ...');
  const A = startServer('A');
  if (!(await waitHealthy())) throw new Error(`server A never became healthy:\n${A.lines.slice(-10).join('\n')}`);

  const alice = await registerSession('shut-alice');
  await sleep(80);
  const bob = await registerSession('shut-bob');
  await sleep(80);
  const a = makeClient(alice, 'alice');
  await waitConnected(a);
  await sleep(300);
  const b = makeClient(bob, 'bob');
  await waitConnected(b);
  await sleep(500);
  check('both clients connected to server A', a.socket.connected && b.socket.connected);

  // ------------------------------------------------------------------ 1
  console.log('\n1. SIGTERM -> clients are told, then reconnect immediately');
  const sigtermAt = Date.now();
  A.child.kill('SIGTERM');
  const exit = await Promise.race([A.exited, sleep(15_000).then(() => 'timeout')]);
  await sleep(300);

  check('both clients received server_shutdown', !!a.probe.noticeAt && !!b.probe.noticeAt);
  check(`notice arrived promptly (${a.probe.noticeAt - sigtermAt}ms / ${b.probe.noticeAt - sigtermAt}ms after SIGTERM)`, a.probe.noticeAt - sigtermAt < 1500 && b.probe.noticeAt - sigtermAt < 1500);
  check('notice came BEFORE the connection dropped', a.probe.noticeAt <= a.probe.disconnectAt && b.probe.noticeAt <= b.probe.disconnectAt);
  console.log(`    (disconnect reasons: alice='${a.probe.disconnectReason}', bob='${b.probe.disconnectReason}')`);
  const dA = delayOf(a.probe);
  const dB = delayOf(b.probe);
  check(`alice's first reconnect attempt came ${dA}ms after the disconnect (must be < 250ms)`, dA !== null && dA < 250);
  check(`bob's first reconnect attempt came ${dB}ms after the disconnect (must be < 250ms)`, dB !== null && dB < 250);
  check('the attempt really went out (a connection error followed immediately: nobody is listening yet)', a.probe.firstAttemptErrorAt !== null && a.probe.firstAttemptErrorAt - a.probe.disconnectAt < 1500);

  check('server A exited by itself with code 0 (not killed, not a crash)', exit !== 'timeout' && exit.code === 0 && exit.signal === null, JSON.stringify(exit));
  const logs = A.lines.join('\n');
  check("server log: 'shutdown initiated' (signal SIGTERM)", /shutdown initiated/.test(logs) && /SIGTERM/.test(logs));
  check('server log: broadcast acked by both clients, no timeout', /server_shutdown broadcast complete/.test(logs) && /"acked":2/.test(logs) && /"timedOut":false/.test(logs), A.lines.filter((l) => /broadcast/.test(l)).join(' '));
  check('server log: listener and database pool closed in order', logs.indexOf('socket server and http listener closed') > -1 && logs.indexOf('database pool closed') > logs.indexOf('socket server and http listener closed'));
  const shutdownMs = exit?.code === 0 ? Date.now() - sigtermAt : null;
  console.log(`    (SIGTERM -> exit took about ${shutdownMs}ms)`);

  // ------------------------------------------------------------------ 2
  console.log('\n2. A replacement server comes up: clients reconnect by themselves and can work');
  const B = startServer('B');
  if (!(await waitHealthy())) throw new Error(`server B never became healthy:\n${B.lines.slice(-10).join('\n')}`);
  const upAt = Date.now();
  const ra = await waitConnected(a, 25_000);
  const rb = await waitConnected(b, 25_000);
  check(`alice reconnected on her own (${ra ? Date.now() - upAt : '-'}ms after B was healthy)`, ra);
  check('bob reconnected on his own', rb);
  check('new socket ids (a real reconnect, not a survivor)', a.probe.connectedIds.length === 2 && a.probe.connectedIds[0] !== a.probe.connectedIds[1]);

  const room = await fetch(`${BASE_URL}/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ name: `shut-${Date.now()}` }) }).then((r) => r.json());
  await sleep(100);
  check('join_room works on the new connection', await joinRoomEvent(a.socket, room.id));

  // ------------------------------------------------------------------ 3
  console.log('\n3. Control: SIGKILL (no notice possible) -> the same clients wait out ordinary backoff');
  a.probe.disconnectAt = null;
  b.probe.disconnectAt = null;
  const killAt = Date.now();
  B.child.kill('SIGKILL');
  await B.exited;
  await sleep(2500);
  const cA = delayOf(a.probe);
  const cB = delayOf(b.probe);
  check(`alice's first attempt after SIGKILL came ${cA}ms after the disconnect (backoff: expected >= 400ms)`, cA !== null && cA >= 400, `reason=${a.probe.disconnectReason}`);
  check(`bob's first attempt after SIGKILL came ${cB}ms after the disconnect (expected >= 400ms)`, cB !== null && cB >= 400);
  check('clients were NOT told anything this time (no notice before the drop)', !(a.probe.noticeAt && a.probe.noticeAt > killAt) && !(b.probe.noticeAt && b.probe.noticeAt > killAt));

  a.detach();
  b.detach();
  a.socket.close();
  b.socket.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('script crashed:', e);
  process.exit(1);
});
