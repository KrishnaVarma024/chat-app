#!/usr/bin/env node
/**
 * Verifies Phase 14's SERVER-observable "definition of done" against a
 * running server — the receiving-client auto-clear safety net is pure
 * React/timer state with no server involvement at all, and is verified
 * separately and deterministically with fake timers in
 * client/src/realtime/typingTracker.test.ts (see that file's own doc
 * comment for why a Node script can't exercise it). What THIS script
 * proves is the half of the contract only a real server can prove:
 *   1. typing_start/typing_stop relay correctly between two joined
 *      clients in the same room (and are excluded from the sender's own
 *      socket, same as new_message).
 *   2. A socket that never joined the room — i.e. never passed
 *      join_room's real, DB-backed membership check — gets rejected with
 *      FORBIDDEN rather than having its typing_start silently relayed,
 *      proving the socket.rooms-based authorization check actually does
 *      something (see typing.socket.ts's own doc comment on why this
 *      matters even in a "no DB access" handler).
 *   3. A burst of typing_start/typing_stop activity produces ZERO new
 *      message rows and leaves the room's latest sequence number
 *      unchanged — the defining property of this phase (ephemeral data,
 *      never persisted).
 *
 * Test 3 proves "zero DB writes" through the public HTTP API
 * (GET /rooms/:roomId/messages, Phase 5's cursor-pagination endpoint)
 * rather than by opening a second direct Postgres connection from this
 * script. Two reasons: it's a strictly black-box-stronger proof (the only
 * way a caller could ever observe a write existing is through the API
 * surface the app actually exposes), and this sandbox's PGlite stand-in
 * (tests/setup/globalSetup.ts) tolerates a second simultaneous raw
 * connection poorly — opening one alongside the already-connected app
 * server intermittently broke EVERY query on the shared instance,
 * including ones unrelated to this script (reproduced with
 * concurrency-test.mjs too), never a real Postgres behavior. Combined with
 * typing.socket.ts's own doc comment — it imports no repo/pool module at
 * all — the static "no DB access is even possible" proof plus this
 * dynamic "the row count the API reports didn't move" proof together cover
 * the claim without needing a second connection.
 *
 * Requires the API server already running against this sandbox's PGlite
 * stand-in or a real Postgres.
 *
 * Usage: API_URL=http://localhost:4000 node scripts/typing-test.mjs
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

/** Snapshot of everything Test 3 needs, read through the SAME public
 * endpoint a real client's scrollback/poll would use (Phase 5). */
async function snapshotMessages(accessToken, roomId) {
  const res = await fetch(`${BASE_URL}/rooms/${roomId}/messages?limit=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`setup: message snapshot failed ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { count: body.messages.length, latestSequenceNumber: body.latest_sequence_number };
}

function connectAndWait(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, { auth: { token }, reconnection: false, timeout: 5000 });
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Connects, then joins, with a small pause after each step — not something
 * production needs, but PGlite (this sandbox's Postgres stand-in; see
 * tests/setup/globalSetup.ts) is architecturally single-connection, and
 * every connection already fires two unawaited DB calls of its own
 * (findUserById for usernameReady, then markOnline's chained lookup) before
 * this script's own join_room adds a third (checkRoomMembership). Two
 * sockets connecting back-to-back with no gap can overlap those calls on
 * PGlite's one real connection and throw "Connection terminated
 * unexpectedly" — a sandbox ceiling already hit and documented in every
 * prior phase's script (presence-test.mjs's connectJoinAndSettle is the
 * same fix for the same reason), never a real Postgres one. Staggering
 * setup sidesteps it rather than papering over it.
 */
async function connectJoinAndSettle(token, roomId) {
  const socket = await connectAndWait(token);
  await sleep(60);
  await joinRoomAndWait(socket, roomId);
  await sleep(60);
  return socket;
}

function waitForEvent(socket, eventName, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${eventName}`)), timeoutMs);
    socket.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  const alice = await registerFreshUser('typing-alice');
  await sleep(60);
  const bob = await registerFreshUser('typing-bob');
  await sleep(60);
  const carol = await registerFreshUser('typing-carol'); // deliberately NEVER joins the room
  await sleep(60);
  const room = await createRoom(alice.accessToken, 'typing-room');
  await sleep(60);
  await joinRoomHttp(bob.accessToken, room.id);
  await sleep(60);

  const aliceSocket = await connectJoinAndSettle(alice.accessToken, room.id);
  const bobSocket = await connectJoinAndSettle(bob.accessToken, room.id);
  // Carol connects but never calls join_room for this room at all — she
  // has no socket.io room membership for it, same as a client that knows
  // a room id exists but was never added as a member.
  const carolSocket = await connectAndWait(carol.accessToken);
  await sleep(60);

  // === Test 1: typing relays correctly between two joined clients ===
  console.log('1. typing_start / typing_stop relay correctly between two joined clients');
  {
    const typingPromise = waitForEvent(bobSocket, 'typing');
    const aliceGotOwnTyping = waitForEvent(aliceSocket, 'typing', 300).then(
      () => true,
      () => false
    );
    aliceSocket.emit('typing_start', { roomId: room.id });
    const typingEvent = await typingPromise;
    check(
      "bob receives typing with alice's userId and the right roomId",
      typingEvent.userId === alice.user.id && typingEvent.roomId === room.id,
      JSON.stringify(typingEvent)
    );
    check('alice does NOT receive her own typing_start echoed back', (await aliceGotOwnTyping) === false);

    const stoppedPromise = waitForEvent(bobSocket, 'stopped_typing');
    aliceSocket.emit('typing_stop', { roomId: room.id });
    const stoppedEvent = await stoppedPromise;
    check(
      "bob receives stopped_typing with alice's userId",
      stoppedEvent.userId === alice.user.id && stoppedEvent.roomId === room.id,
      JSON.stringify(stoppedEvent)
    );
  }

  // === Test 2: a socket that never joined the room is rejected, not relayed ===
  console.log('2. A socket that never called join_room for this room gets FORBIDDEN, not a silent relay');
  {
    const bobShouldNotSeeThis = waitForEvent(bobSocket, 'typing', 300).then(
      () => true,
      () => false
    );
    const errorPromise = waitForEvent(carolSocket, 'error');
    carolSocket.emit('typing_start', { roomId: room.id });
    const errorEvent = await errorPromise;
    check('carol gets an error event, not a silent success', !!errorEvent);
    check('the error code is FORBIDDEN', errorEvent?.error?.code === 'FORBIDDEN', JSON.stringify(errorEvent));
    check("bob never received a typing event from carol's unauthorized attempt", (await bobShouldNotSeeThis) === false);
  }

  // === Test 3: zero database writes during a typing burst ===
  console.log('3. A burst of typing activity produces ZERO new message rows and leaves the sequence counter unchanged');
  {
    const before = await snapshotMessages(alice.accessToken, room.id);

    // A realistic burst: several start/stop cycles back to back, from both
    // joined clients, well beyond what a human typing would actually
    // trigger even without the client-side throttle.
    for (let i = 0; i < 20; i++) {
      aliceSocket.emit('typing_start', { roomId: room.id });
      bobSocket.emit('typing_start', { roomId: room.id });
      aliceSocket.emit('typing_stop', { roomId: room.id });
      bobSocket.emit('typing_stop', { roomId: room.id });
    }
    // Give the server a moment to have fully processed all of the above
    // (these are fire-and-forget emits with no ack to await).
    await sleep(300);

    const after = await snapshotMessages(alice.accessToken, room.id);

    check(
      'message count is unchanged after the burst',
      after.count === before.count,
      `before=${before.count} after=${after.count}`
    );
    check(
      "the room's latest sequence number is unchanged after the burst",
      after.latestSequenceNumber === before.latestSequenceNumber,
      `before=${before.latestSequenceNumber} after=${after.latestSequenceNumber}`
    );
  }

  aliceSocket.close();
  bobSocket.close();
  carolSocket.close();

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
