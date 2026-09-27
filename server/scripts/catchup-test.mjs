#!/usr/bin/env node
/**
 * Verifies Phase 12's "definition of done" against a running server:
 *   1. A client (alice) disconnects, another client (bob) sends several
 *      messages, a third client (carol) stays connected the whole time and
 *      sees them live. Alice reconnects with join_room's sinceSequence set
 *      to the last sequence number she saw before disconnecting, and gets
 *      back a SINGLE catch_up batch containing exactly the messages she
 *      missed — same ids, same order, same content carol saw live — no
 *      more, no less, and NOT delivered again as 'new_message' once she's
 *      rejoined (only a message sent AFTER rejoining arrives that way).
 *   2. A gap bigger than one page (more than DEFAULT_PAGE_LIMIT messages
 *      missed) comes back as a first catch_up batch with hasMore: true;
 *      re-emitting join_room with the updated sinceSequence (the exact
 *      "same mechanism" ARCHITECTURE_V2.md §7 describes) fetches the
 *      remainder in a second batch with hasMore: false — never silently
 *      truncated at the first page boundary.
 *
 * Requires the API server already running (npm run dev) against a real
 * Postgres — same convention as every other scripts/*.mjs in this project.
 *
 * Usage: node scripts/catchup-test.mjs
 */
import { io as ioClient } from 'socket.io-client';

const BASE_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const DEFAULT_PAGE_LIMIT = 50; // must match server/src/db/messages.repo.ts

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

function connectAndWait(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, {
      auth: { token },
      reconnection: false, // manual control — this script drives every "reconnect" itself
      timeout: 5000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${eventName}`)), timeoutMs);
    socket.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Sends one message and waits for ITS ack before returning — sequential on
 * purpose. PGlite (this sandbox's Postgres stand-in — see
 * tests/setup/globalSetup.ts) is architecturally single-connection, so
 * anything that fires several sends concurrently at it can throw
 * "Connection terminated unexpectedly" under load; a real Postgres pool has
 * no such ceiling (proved for real in server/scripts/concurrency-test.mjs).
 * Sequential sends sidestep the sandbox limitation entirely rather than
 * papering over it with a stagger delay, and this test doesn't need
 * concurrent sends to prove anything about catch-up correctness anyway. */
function sendAndWaitForAck(socket, roomId, body) {
  return new Promise((resolve, reject) => {
    const clientMessageId = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error('timed out waiting for message_ack')), 5000);
    socket.once('message_ack', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    socket.emit('send_message', { roomId, body, clientMessageId });
  });
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  // === Test 1: single-page catch-up, verified against a client that stayed connected ===
  console.log('1. Disconnect, miss a few messages, reconnect — catch_up matches exactly what a live client saw');
  {
    const alice = await registerFreshUser('catchup-alice');
    const bob = await registerFreshUser('catchup-bob');
    const carol = await registerFreshUser('catchup-carol');
    const room = await createRoom(alice.accessToken, 'catchup-room-1');
    await joinRoomHttp(bob.accessToken, room.id);
    await joinRoomHttp(carol.accessToken, room.id);

    let aliceSocket = await connectAndWait(alice.accessToken);
    const bobSocket = await connectAndWait(bob.accessToken);
    const carolSocket = await connectAndWait(carol.accessToken);

    // Everyone joins fresh (no sinceSequence — this is each socket's very
    // first join, mirroring a brand-new page load).
    await Promise.all([
      waitForEvent(aliceSocket, 'joined_room').then(() => {}),
      aliceSocket.emit('join_room', { roomId: room.id }),
    ]);
    await Promise.all([
      waitForEvent(bobSocket, 'joined_room').then(() => {}),
      bobSocket.emit('join_room', { roomId: room.id }),
    ]);
    await Promise.all([
      waitForEvent(carolSocket, 'joined_room').then(() => {}),
      carolSocket.emit('join_room', { roomId: room.id }),
    ]);

    // A baseline message everyone sees live, establishing alice's
    // "last known sequence" before she goes away. Racy if done naively:
    // the server emits message_ack (to bob) and new_message (to carol)
    // back-to-back, in-flight over the network at essentially the same
    // instant — attaching carol's recording listener right after OUR await
    // on bob's ack resolves does NOT guarantee carol's copy of THIS
    // specific message has already arrived and been dispatched (Socket.IO
    // doesn't queue an event for a listener that isn't registered yet; a
    // packet that arrives with no listener attached is simply gone). So
    // explicitly wait for carol's own receipt of the baseline, via a
    // ONE-TIME listener, before attaching the listener that records
    // everything after it — that ordering is what actually rules the race
    // out, not hoping an await happens to resolve in a convenient order.
    const [baseline] = await Promise.all([
      sendAndWaitForAck(bobSocket, room.id, 'baseline, seen live by everyone'),
      waitForEvent(carolSocket, 'new_message'),
    ]);
    let aliceLastKnownSequence = baseline.sequence_number;
    const carolSawLive = [];
    carolSocket.on('new_message', (m) => carolSawLive.push(m));
    // Let the live broadcast actually land on alice/carol before she disconnects.
    await new Promise((r) => setTimeout(r, 100));

    aliceSocket.close();

    const missedBodies = ['missed 1', 'missed 2', 'missed 3'];
    const missedAcks = [];
    for (const body of missedBodies) {
      missedAcks.push(await sendAndWaitForAck(bobSocket, room.id, body));
    }
    // sendAndWaitForAck resolves on BOB's own ack — a completely separate
    // network delivery from carol's broadcast copy of the same message
    // (server emits them back-to-back, but "bob's ack arrived" says
    // nothing about whether carol's copy has landed and been dispatched
    // yet). Asserting immediately after the loop is exactly the same class
    // of race already fixed above for the baseline message — poll briefly
    // instead of assuming delivery order across two different sockets.
    await new Promise((resolve) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        if (carolSawLive.length >= missedBodies.length || Date.now() > deadline) return resolve();
        setTimeout(poll, 25);
      };
      poll();
    });
    check(
      'carol (stayed connected) saw all 3 missed messages live, in order',
      carolSawLive.length === 3 && carolSawLive.every((m, i) => m.client_message_id === missedAcks[i].client_message_id),
      JSON.stringify(carolSawLive.map((m) => m.body))
    );

    // Reconnect as alice, on a FRESH socket (a real reconnect, not the same
    // object) — carrying the sequence number from before she disconnected.
    aliceSocket = await connectAndWait(alice.accessToken);
    const catchUpPromise = waitForEvent(aliceSocket, 'catch_up');
    const newMessagesWhileCatchingUp = [];
    aliceSocket.on('new_message', (m) => newMessagesWhileCatchingUp.push(m));
    aliceSocket.emit('join_room', { roomId: room.id, sinceSequence: aliceLastKnownSequence });
    const catchUp = await catchUpPromise;
    await waitForEvent(aliceSocket, 'joined_room');

    check('catch_up is scoped to the right room', catchUp.roomId === room.id, catchUp.roomId);
    check(
      'catch_up contains exactly the 3 missed messages, in order',
      catchUp.messages.length === 3 &&
        catchUp.messages.every((m, i) => m.client_message_id === missedAcks[i].client_message_id),
      JSON.stringify(catchUp.messages.map((m) => m.body))
    );
    check('hasMore is false — everything fit in one page', catchUp.hasMore === false);
    check(
      'latestSequenceNumber matches the last missed message',
      catchUp.latestSequenceNumber === missedAcks[missedAcks.length - 1].sequence_number,
      catchUp.latestSequenceNumber
    );
    check(
      'the missed messages did NOT also arrive as live new_message events after rejoining',
      newMessagesWhileCatchingUp.length === 0,
      JSON.stringify(newMessagesWhileCatchingUp)
    );

    // One more message sent AFTER alice has rejoined — proves live delivery
    // resumed correctly and (together with the check above) that nothing
    // is double-delivered across the catch_up/live seam.
    aliceLastKnownSequence = catchUp.latestSequenceNumber;
    const postRejoinPromise = waitForEvent(aliceSocket, 'new_message');
    const postRejoinAck = await sendAndWaitForAck(bobSocket, room.id, 'sent after alice rejoined');
    const postRejoinLive = await postRejoinPromise;
    check(
      'a message sent AFTER rejoining arrives exactly once, live',
      postRejoinLive.client_message_id === postRejoinAck.client_message_id
    );

    aliceSocket.close();
    bobSocket.close();
    carolSocket.close();
  }

  // === Test 2: a gap bigger than one page triggers a follow-up fetch ===
  console.log(`2. A gap of more than ${DEFAULT_PAGE_LIMIT} messages pages correctly, never truncates`);
  {
    const alice = await registerFreshUser('catchup2-alice');
    const bob = await registerFreshUser('catchup2-bob');
    const room = await createRoom(alice.accessToken, 'catchup-room-2');
    await joinRoomHttp(bob.accessToken, room.id);

    let aliceSocket = await connectAndWait(alice.accessToken);
    const bobSocket = await connectAndWait(bob.accessToken);

    await Promise.all([
      waitForEvent(aliceSocket, 'joined_room').then(() => {}),
      aliceSocket.emit('join_room', { roomId: room.id }),
    ]);
    await Promise.all([
      waitForEvent(bobSocket, 'joined_room').then(() => {}),
      bobSocket.emit('join_room', { roomId: room.id }),
    ]);

    // Fresh room — alice's baseline is "nothing sent yet."
    const aliceStartSequence = 0;
    aliceSocket.close();

    const totalMissed = DEFAULT_PAGE_LIMIT + 5; // guarantees a second page
    const sentAcks = [];
    for (let i = 0; i < totalMissed; i++) {
      sentAcks.push(await sendAndWaitForAck(bobSocket, room.id, `gap message ${i}`));
    }
    check(
      `sent exactly ${totalMissed} messages with strictly increasing sequence numbers`,
      sentAcks.every((m, i) => i === 0 || m.sequence_number > sentAcks[i - 1].sequence_number)
    );

    aliceSocket = await connectAndWait(alice.accessToken);
    const firstBatchPromise = waitForEvent(aliceSocket, 'catch_up');
    aliceSocket.emit('join_room', { roomId: room.id, sinceSequence: aliceStartSequence });
    const firstBatch = await firstBatchPromise;

    check(
      'first catch_up page is exactly DEFAULT_PAGE_LIMIT messages',
      firstBatch.messages.length === DEFAULT_PAGE_LIMIT,
      firstBatch.messages.length
    );
    check('first page reports hasMore: true', firstBatch.hasMore === true);

    // "Same mechanism" — re-emit join_room with the updated cursor, exactly
    // what ChatRoomPage's handleCatchUp does client-side.
    const secondBatchPromise = waitForEvent(aliceSocket, 'catch_up');
    aliceSocket.emit('join_room', { roomId: room.id, sinceSequence: firstBatch.latestSequenceNumber });
    const secondBatch = await secondBatchPromise;

    check(
      'second catch_up page has exactly the remaining 5 messages',
      secondBatch.messages.length === totalMissed - DEFAULT_PAGE_LIMIT,
      secondBatch.messages.length
    );
    check('second page reports hasMore: false — nothing left to fetch', secondBatch.hasMore === false);

    const allCaughtUp = [...firstBatch.messages, ...secondBatch.messages];
    check(
      'combined pages equal every message sent, in the exact order sent, with no gaps or duplicates',
      allCaughtUp.length === totalMissed &&
        allCaughtUp.every((m, i) => m.client_message_id === sentAcks[i].client_message_id),
      `got ${allCaughtUp.length}, expected ${totalMissed}`
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
