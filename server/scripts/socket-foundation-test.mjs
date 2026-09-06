#!/usr/bin/env node
/**
 * Verifies the Phase 9 "definition of done" against a running server:
 *   1. Connecting with no token is rejected at the handshake (never fires
 *      'connect', fires 'connect_error' instead).
 *   2. Connecting with a garbage/invalid token is rejected the same way.
 *   3. Connecting with a valid access token succeeds.
 *   4. join_room on a room the user IS a member of emits 'joined_room'.
 *   5. join_room on a room the user is NOT a member of emits an 'error'
 *      event with the same FORBIDDEN code the HTTP API uses.
 *   6. join_room on a room that doesn't exist at all emits 'error' with
 *      NOT_FOUND — a different code than #5, on purpose (rooms.middleware.ts).
 *   7. leave_room emits 'left_room'.
 *
 * Requires the API server already running (npm run dev) against a real
 * Postgres — same convention as hardening-test.mjs and the other scripts
 * in this directory.
 *
 * Usage: node scripts/socket-foundation-test.mjs
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

/** Connects and resolves once either 'connect' or 'connect_error' fires —
 * whichever happens, this test cares about the OUTCOME of the handshake,
 * not about racing a real network timeout. */
function connectAndWait(token) {
  return new Promise((resolve) => {
    const socket = ioClient(BASE_URL, {
      auth: token === undefined ? {} : { token },
      reconnection: false, // one attempt only — this script is testing the handshake itself, not backoff (that's Phase 11)
      timeout: 5000,
    });
    socket.once('connect', () => resolve({ socket, connected: true, error: null }));
    socket.once('connect_error', (err) => resolve({ socket, connected: false, error: err.message }));
  });
}

/** Emits an event and resolves with the first matching response event
 * (whichever of the given event names fires first). */
function emitAndWait(socket, emitEvent, payload, responseEvents) {
  return new Promise((resolve) => {
    const cleanup = [];
    for (const evt of responseEvents) {
      const handler = (data) => {
        cleanup.forEach((fn) => fn());
        resolve({ event: evt, data });
      };
      socket.once(evt, handler);
      cleanup.push(() => socket.off(evt, handler));
    }
    socket.emit(emitEvent, payload);
  });
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  // 1. No token at all.
  console.log('1. Connect with no token');
  {
    const { connected, error, socket } = await connectAndWait(undefined);
    check('handshake is rejected', connected === false, `connected=${connected}`);
    check('rejection reason is UNAUTHORIZED', error === 'UNAUTHORIZED', error);
    socket.close();
  }

  // 2. Garbage token.
  console.log('2. Connect with an invalid token');
  {
    const { connected, error, socket } = await connectAndWait('not-a-real-jwt');
    check('handshake is rejected', connected === false, `connected=${connected}`);
    check('rejection reason is UNAUTHORIZED', error === 'UNAUTHORIZED', error);
    socket.close();
  }

  // 3. Valid token.
  console.log('3. Connect with a valid access token');
  const alice = await registerFreshUser('socketfoundation-alice');
  let aliceSocket;
  {
    const { connected, socket } = await connectAndWait(alice.accessToken);
    check('handshake succeeds', connected === true);
    aliceSocket = socket;
  }

  // 4. Join a room alice is actually a member of (she owns it — creating a
  // room makes you its owner, same as the HTTP flow in Phase 3).
  console.log('4. join_room — member of the room');
  const room = await createRoom(alice.accessToken, 'socket-foundation-room');
  {
    const { event, data } = await emitAndWait(aliceSocket, 'join_room', { roomId: room.id }, ['joined_room', 'error']);
    check('receives joined_room, not error', event === 'joined_room', JSON.stringify({ event, data }));
    check('payload echoes the room id', data?.roomId === room.id, JSON.stringify(data));
  }

  // 5. A second user, NOT a member of alice's room, tries to join it.
  console.log('5. join_room — not a member (expect FORBIDDEN)');
  const bob = await registerFreshUser('socketfoundation-bob');
  const { socket: bobSocket } = await connectAndWait(bob.accessToken);
  {
    const { event, data } = await emitAndWait(bobSocket, 'join_room', { roomId: room.id }, ['joined_room', 'error']);
    check('receives error, not joined_room', event === 'error', JSON.stringify({ event, data }));
    check('error code is FORBIDDEN', data?.error?.code === 'FORBIDDEN', JSON.stringify(data));
  }

  // 6. Joining a room that doesn't exist at all — different code than #5.
  console.log('6. join_room — room does not exist (expect NOT_FOUND)');
  {
    const bogusRoomId = 999_999_999;
    const { event, data } = await emitAndWait(bobSocket, 'join_room', { roomId: bogusRoomId }, ['joined_room', 'error']);
    check('receives error, not joined_room', event === 'error', JSON.stringify({ event, data }));
    check('error code is NOT_FOUND', data?.error?.code === 'NOT_FOUND', JSON.stringify(data));
  }

  // 7. Leaving a room.
  console.log('7. leave_room');
  {
    const { event, data } = await emitAndWait(aliceSocket, 'leave_room', { roomId: room.id }, ['left_room']);
    check('receives left_room', event === 'left_room', JSON.stringify({ event, data }));
    check('payload echoes the room id', data?.roomId === room.id, JSON.stringify(data));
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
