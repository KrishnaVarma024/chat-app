#!/usr/bin/env node
/**
 * Verifies Phase 13's "definition of done" against a running server:
 *   1. A connection that goes silent WITHOUT a clean close (no WebSocket
 *      close frame, no FIN from the client) is still detected as dead —
 *      by the server's own heartbeat timeout, not left hanging — and
 *      presence correctly flips that user offline once the grace period
 *      on top of that also elapses.
 *   2. Opening a second connection as the same user (two tabs) does NOT
 *      re-announce 'online', and closing only one of them does NOT
 *      announce 'offline' — reference counting, not "is any one socket
 *      connected."
 *   3. A disconnect immediately followed by a reconnect within the grace
 *      window produces ZERO presence broadcasts at all — the exact "page
 *      refresh shouldn't flicker your status" case ARCHITECTURE_V2.md §9
 *      names by name.
 *
 * Requires the API server running with SMALL heartbeat/grace-period env
 * overrides (see env.ts) so this can run in seconds instead of minutes —
 * e.g. SOCKET_PING_INTERVAL_MS=300 SOCKET_PING_TIMEOUT_MS=300
 * PRESENCE_GRACE_PERIOD_MS=400. Production keeps the documented 25s/20s/7s
 * defaults; only this verification run overrides them.
 *
 * Usage: node scripts/presence-test.mjs
 */
import { io as ioClient } from 'socket.io-client';

const BASE_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS — ${label}`);
  } else {
    console.error(`  FAIL — ${label}${detail ? ` (${detail})` : ''}`);
    failures++;
  }
}

async function registerFreshUser(label) {
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
  if (!res.ok) throw new Error(`setup: register failed ${res.status} ${await res.text()}`);
  return res.json();
}

async function createRoom(accessToken, name) {
  const res = await fetch(`${BASE_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`setup: create room failed ${res.status} ${await res.text()}`);
  return res.json();
}

async function joinRoomHttp(accessToken, roomId) {
  const res = await fetch(`${BASE_URL}/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`setup: HTTP join failed ${res.status} ${await res.text()}`);
}

function connectAndWait(token, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, {
      auth: { token },
      reconnection: false,
      timeout: 5000,
      ...opts,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function joinRoomAndWait(socket, roomId) {
  return new Promise((resolve, reject) => {
    socket.once('joined_room', resolve);
    socket.once('error', reject);
    socket.emit('join_room', { roomId });
  });
}

/** Records every occurrence of an event with its arrival timestamp, for
 * both "did it eventually happen" and "how long did it take" assertions. */
function recordEvents(socket, eventName) {
  const events = [];
  socket.on(eventName, (data) => events.push({ data, at: Date.now() }));
  return events;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(predicate, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

/**
 * Connects, then joins the room, with a small pause AFTER each — not
 * because production needs this, but because PGlite (this sandbox's
 * Postgres stand-in; see tests/setup/globalSetup.ts) is architecturally
 * single-connection, and presence adds a THIRD unawaited DB call
 * (markOnline's listRoomsForUser) on top of the two Phase 9/10 already fire
 * per connection (findUserById for usernameReady, checkRoomMembership for
 * join_room) — two sockets connecting back-to-back can throw "Connection
 * terminated unexpectedly" under that combined load, a sandbox ceiling
 * already hit and documented in every prior phase's script, never a real
 * Postgres one (concurrency-test.mjs proved that for real). Staggering
 * setup sidesteps it entirely rather than papering over it.
 */
async function connectJoinAndSettle(token, roomId, opts = {}) {
  const socket = await connectAndWait(token, opts);
  await sleep(60);
  await joinRoomAndWait(socket, roomId);
  await sleep(60);
  return socket;
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  // === Test 1: heartbeat detects a connection that goes silent without a clean close ===
  console.log('1. A connection that goes silent (no close frame) is still detected as dead via heartbeat, then presence flips offline');
  {
    const alice = await registerFreshUser('presence1-alice');
    await sleep(60);
    const bob = await registerFreshUser('presence1-bob');
    await sleep(60);
    const room = await createRoom(alice.accessToken, 'presence-room-1');
    await sleep(60);
    await joinRoomHttp(bob.accessToken, room.id);
    await sleep(60);

    const bobSocket = await connectJoinAndSettle(bob.accessToken, room.id);
    const bobPresenceEvents = recordEvents(bobSocket, 'presence');

    // Forced to a single transport, no upgrade dance, specifically so
    // `.io.engine.transport.ws` is guaranteed to exist and be the live
    // transport immediately after 'connect' — this test needs direct
    // access to the raw WebSocket to simulate a connection that goes dark
    // without ever sending a close frame.
    const aliceSocket = await connectJoinAndSettle(alice.accessToken, room.id, {
      transports: ['websocket'],
      upgrade: false,
    });

    const onlineEventsSoFar = bobPresenceEvents.filter((e) => e.data.status === 'online').length;
    check('bob saw alice come online after she joined', onlineEventsSoFar === 1, onlineEventsSoFar);

    // The actual simulation: pause the underlying raw socket's data flow.
    // This is NOT the same as socket.close()/disconnect() — no WebSocket
    // close frame is sent, no FIN. From the SERVER's point of view, alice's
    // connection simply stops answering — indistinguishable from a laptop
    // closing its lid or a NAT silently dropping the path, which is
    // exactly the scenario ARCHITECTURE_V2.md §8 describes. Only the
    // server's own ping/pong timer will ever notice.
    aliceSocket.io.engine.transport.ws.pause();

    const pauseTime = Date.now();

    // Immediately after pausing, nothing should have happened yet — if an
    // 'offline' shows up this fast, something OTHER than the heartbeat
    // timeout is doing the detecting (e.g. an immediate TCP-level event),
    // which would mean this test isn't actually proving what it claims to.
    await sleep(50);
    const offlineImmediately = bobPresenceEvents.some((e) => e.data.status === 'offline');
    check('offline is NOT broadcast immediately after going silent', !offlineImmediately);

    // Eventually — after roughly pingInterval + pingTimeout (server-side
    // heartbeat) + the presence grace period — it should arrive.
    const gotOffline = await waitUntil(
      () => bobPresenceEvents.some((e) => e.data.status === 'offline' && e.data.userId === alice.user.id),
      15000
    );
    check('bob eventually sees alice go offline (heartbeat + grace period)', gotOffline);
    if (gotOffline) {
      const offlineEvent = bobPresenceEvents.find((e) => e.data.status === 'offline');
      const elapsedMs = offlineEvent.at - pauseTime;
      console.log(`    (took ${elapsedMs}ms from going silent to the offline broadcast)`);
    }

    bobSocket.close();
    // aliceSocket is already effectively dead server-side; close() on a
    // paused transport may itself hang, so just let the process exit clean
    // it up rather than waiting on it.
  }

  // === Test 2: reference counting across multiple sockets for the same user ===
  console.log('2. Two tabs (two sockets) as the same user — reference-counted, not "any one socket"');
  {
    const alice = await registerFreshUser('presence2-alice');
    await sleep(60);
    const bob = await registerFreshUser('presence2-bob');
    await sleep(60);
    const room = await createRoom(alice.accessToken, 'presence-room-2');
    await sleep(60);
    await joinRoomHttp(bob.accessToken, room.id);
    await sleep(60);

    const bobSocket = await connectJoinAndSettle(bob.accessToken, room.id);
    const bobPresenceEvents = recordEvents(bobSocket, 'presence');

    const aliceTab1 = await connectJoinAndSettle(alice.accessToken, room.id);
    check(
      'exactly one "online" after alice\'s FIRST tab connects',
      bobPresenceEvents.filter((e) => e.data.status === 'online').length === 1
    );

    const aliceTab2 = await connectJoinAndSettle(alice.accessToken, room.id);
    check(
      'still exactly one "online" total after her SECOND tab connects — no re-announcement',
      bobPresenceEvents.filter((e) => e.data.status === 'online').length === 1
    );

    aliceTab1.close();
    await sleep(200);
    check(
      'closing ONE of two tabs produces no "offline" — she still has a live connection',
      bobPresenceEvents.filter((e) => e.data.status === 'offline').length === 0
    );

    aliceTab2.close();
    const gotOffline = await waitUntil(
      () => bobPresenceEvents.some((e) => e.data.status === 'offline'),
      5000
    );
    check('closing the LAST tab eventually produces exactly one "offline"', gotOffline);
    check(
      'still exactly one "offline" total (not one per tab)',
      bobPresenceEvents.filter((e) => e.data.status === 'offline').length === 1
    );

    bobSocket.close();
  }

  // === Test 3: reconnect within the grace window produces ZERO broadcasts ===
  console.log('3. Disconnect immediately followed by a reconnect within the grace window — zero presence broadcasts at all');
  {
    const alice = await registerFreshUser('presence3-alice');
    await sleep(60);
    const bob = await registerFreshUser('presence3-bob');
    await sleep(60);
    const room = await createRoom(alice.accessToken, 'presence-room-3');
    await sleep(60);
    await joinRoomHttp(bob.accessToken, room.id);
    await sleep(60);

    const bobSocket = await connectJoinAndSettle(bob.accessToken, room.id);
    const bobPresenceEvents = recordEvents(bobSocket, 'presence');

    let aliceSocket = await connectJoinAndSettle(alice.accessToken, room.id);
    const eventsBeforeRefresh = bobPresenceEvents.length;
    check('exactly one event (the initial online) before the simulated refresh', eventsBeforeRefresh === 1);

    // Simulate a page refresh: a clean disconnect immediately followed by a
    // brand-new connection — well within the grace period.
    aliceSocket.close();
    await sleep(60);
    aliceSocket = await connectJoinAndSettle(alice.accessToken, room.id);

    // Wait out MORE than the grace period to be sure a delayed "offline"
    // (or a spurious extra "online") isn't just running late.
    await sleep(1500);
    check(
      'zero NEW presence events fired across the whole disconnect-then-reconnect — bob never saw anything change',
      bobPresenceEvents.length === eventsBeforeRefresh,
      `total events: ${bobPresenceEvents.length}`
    );

    aliceSocket.close();
    bobSocket.close();
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
