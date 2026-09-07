#!/usr/bin/env node
/**
 * Verifies Phase 10's "definition of done" against a running server:
 *   1. Two connected, joined clients: alice sends, she gets 'message_ack'
 *      with the real row; bob (the other room member) gets 'new_message'
 *      with the SAME sequence number and alice's username attached.
 *   2. Retrying the exact same clientMessageId (simulating "did that even
 *      go through?") produces exactly one row in the database, and BOTH
 *      message_acks resolve with the same id and sequence_number.
 *   3. send_message is authorized independently of join_room — a member
 *      who never joined the room's socket channel can still send.
 *   4. send_message to a room the sender is NOT a member of is rejected
 *      with FORBIDDEN, and the error payload echoes back the
 *      clientMessageId that failed (so the client can fail just that one
 *      optimistic bubble, not guess via a timeout).
 *   5. send_message with an empty body is rejected with VALIDATION_ERROR,
 *      same as the HTTP route.
 *
 * Requires the API server already running (npm run dev) against a real
 * Postgres — same convention as socket-foundation-test.mjs.
 *
 * Usage: node scripts/socket-messaging-test.mjs
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
  if (!res.ok) throw new Error(`setup: join room failed ${res.status} ${await res.text()}`);
}

async function pollHttp(accessToken, roomId) {
  const res = await fetch(`${BASE_URL}/rooms/${roomId}/messages?after=${encodeCursor(0)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`setup: poll failed ${res.status} ${await res.text()}`);
  return res.json();
}

// Mirrors client/src/api/cursor.ts's encodeCursor — this script has no
// access to the client package, so the wire format is reproduced here
// rather than imported across the client/server boundary.
function encodeCursor(sequenceNumber) {
  return Buffer.from(JSON.stringify({ seq: sequenceNumber }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function connectAndWait(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, { auth: { token }, reconnection: false, timeout: 5000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${eventName}'`)), timeoutMs);
    socket.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  const alice = await registerFreshUser('socketmsg-alice');
  const bob = await registerFreshUser('socketmsg-bob');
  const room = await createRoom(alice.accessToken, 'socket-messaging-room');
  await joinRoomHttp(bob.accessToken, room.id);

  // Connects and joins are deliberately SEQUENTIAL, not Promise.all'd, and
  // not back-to-back either — PGlite (this script's DB when run against the
  // sandbox dev server) is architecturally single-connection, same
  // limitation the vitest harness works around with `fileParallelism:
  // false` (tests/setup/globalSetup.ts). Two sockets connecting in the same
  // instant each kick off their own findUserById lookup (realtime/
  // socket.ts), and two concurrent queries against PGlite's one connection
  // can throw "Connection terminated unexpectedly." Against the real
  // Postgres pool this app actually deploys against, concurrent connections
  // are a non-issue — this stagger exists purely so this *manual sandbox
  // script* doesn't trip a known PGlite ceiling; it is not a production
  // concurrency fix; see concurrency-test.mjs for a scenario that DOES
  // require genuine concurrency and, for that reason, requires a real
  // Postgres (docker-compose) to run at all.
  const aliceSocket = await connectAndWait(alice.accessToken);
  await new Promise((r) => setTimeout(r, 150));
  const bobSocket = await connectAndWait(bob.accessToken);
  await new Promise((r) => setTimeout(r, 150));

  // 1. Both join, alice sends, both sides see the same message land.
  console.log('1. Live send/ack/broadcast between two joined clients');
  {
    await new Promise((r) => {
      aliceSocket.emit('join_room', { roomId: room.id });
      aliceSocket.once('joined_room', r);
    });
    await new Promise((r) => {
      bobSocket.emit('join_room', { roomId: room.id });
      bobSocket.once('joined_room', r);
    });

    const clientMessageId = crypto.randomUUID();
    const [ack, broadcast] = await Promise.all([
      waitForEvent(aliceSocket, 'message_ack'),
      waitForEvent(bobSocket, 'new_message'),
      Promise.resolve(aliceSocket.emit('send_message', { roomId: room.id, body: 'hello bob', clientMessageId })),
    ]);

    check('ack echoes the clientMessageId', ack.client_message_id === clientMessageId, JSON.stringify(ack));
    check('ack has no sender_username (sender already knows their own name)', ack.sender_username === undefined);
    check('bob receives new_message with the same sequence number', broadcast.sequence_number === ack.sequence_number);
    check(
      "bob's copy carries alice's username",
      broadcast.sender_username === alice.user.username,
      JSON.stringify(broadcast)
    );
  }

  // 2. Idempotent retry over the socket — same guarantee as the HTTP path,
  // now exercised through send_message instead of POST /messages.
  console.log('2. Retry with the same clientMessageId — exactly one row, same sequence both times');
  {
    const clientMessageId = crypto.randomUUID();
    const firstAck = await new Promise((resolve) => {
      aliceSocket.once('message_ack', resolve);
      aliceSocket.emit('send_message', { roomId: room.id, body: 'are you still there?', clientMessageId });
    });
    const secondAck = await new Promise((resolve) => {
      aliceSocket.once('message_ack', resolve);
      aliceSocket.emit('send_message', { roomId: room.id, body: 'are you still there?', clientMessageId });
    });

    check('both acks share the same id', firstAck.id === secondAck.id, `${firstAck.id} vs ${secondAck.id}`);
    check(
      'both acks share the same sequence_number',
      firstAck.sequence_number === secondAck.sequence_number,
      `${firstAck.sequence_number} vs ${secondAck.sequence_number}`
    );

    const page = await pollHttp(alice.accessToken, room.id);
    const matching = page.messages.filter((m) => m.client_message_id === clientMessageId);
    check('exactly one row exists in the database for that clientMessageId', matching.length === 1, matching.length);
  }

  // 3. Sending doesn't require having called join_room first — membership
  // is checked against the database (checkRoomMembership), not against
  // Socket.IO's own room bookkeeping.
  console.log('3. send_message works without ever calling join_room (membership is DB-checked, not socket-state-checked)');
  {
    const neverJoinedSocket = await connectAndWait(bob.accessToken);
    const clientMessageId = crypto.randomUUID();
    const ack = await new Promise((resolve, reject) => {
      neverJoinedSocket.once('message_ack', resolve);
      neverJoinedSocket.once('error', reject);
      neverJoinedSocket.emit('send_message', { roomId: room.id, body: 'never joined, still a member', clientMessageId });
    });
    check('message_ack still arrives', ack.client_message_id === clientMessageId, JSON.stringify(ack));
    neverJoinedSocket.close();
  }

  // 4. Non-member send is rejected, and the error names the failing send.
  console.log('4. send_message to a room the sender is NOT a member of (expect FORBIDDEN)');
  {
    const carol = await registerFreshUser('socketmsg-carol');
    const carolSocket = await connectAndWait(carol.accessToken);
    const clientMessageId = crypto.randomUUID();
    const err = await new Promise((resolve) => {
      carolSocket.once('error', resolve);
      carolSocket.emit('send_message', { roomId: room.id, body: 'sneaking in', clientMessageId });
    });
    check('error code is FORBIDDEN', err?.error?.code === 'FORBIDDEN', JSON.stringify(err));
    check('error echoes the failing clientMessageId', err?.clientMessageId === clientMessageId, JSON.stringify(err));
    carolSocket.close();
  }

  // 5. Schema-invalid input is rejected the same way the HTTP route does.
  console.log('5. send_message with an empty body (expect VALIDATION_ERROR)');
  {
    const clientMessageId = crypto.randomUUID();
    const err = await new Promise((resolve) => {
      aliceSocket.once('error', resolve);
      aliceSocket.emit('send_message', { roomId: room.id, body: '', clientMessageId });
    });
    check('error code is VALIDATION_ERROR', err?.error?.code === 'VALIDATION_ERROR', JSON.stringify(err));
    check('error echoes the failing clientMessageId', err?.clientMessageId === clientMessageId, JSON.stringify(err));
  }

  aliceSocket.close();
  bobSocket.close();

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
