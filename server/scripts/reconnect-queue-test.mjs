#!/usr/bin/env node
/**
 * Verifies Phase 11's "definition of done" against a running server:
 *   1. A message emitted, then the connection is killed before its ack
 *      can possibly have arrived (the exact "in flight at the moment of
 *      disconnect" case) — resending the same clientMessageId on a fresh
 *      connection lands it exactly once, not twice.
 *   2. Several messages "queued while offline" (never sent on the first
 *      connection at all) replay, in order, on the next connection, and
 *      land with strictly increasing sequence numbers in that same order
 *      — proving replay-in-order, not just replay.
 *   3. Resending a clientMessageId that WAS already fully acked before
 *      the disconnect is still safe — the resend's ack reports the exact
 *      same id and sequence_number as the original, never a new row.
 *
 * This script exercises the SERVER-side guarantee the client-side outbox
 * (client/src/realtime/outbox.ts) depends on — that guarantee is: however
 * many times, and in whatever connection state, the same clientMessageId
 * gets emitted, it collapses to exactly one row. The outbox's own
 * mechanics (localStorage persistence, in-memory queue ordering) are
 * proven separately, fast and deterministically, by
 * client/src/realtime/outbox.test.ts — this script proves the half of
 * the contract that only a real server can prove.
 *
 * Requires the API server already running (npm run dev) against a real
 * Postgres — same convention as socket-foundation-test.mjs and
 * socket-messaging-test.mjs.
 *
 * Usage: node scripts/reconnect-queue-test.mjs
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

function encodeCursor(sequenceNumber) {
  return Buffer.from(JSON.stringify({ seq: sequenceNumber }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function pollHttp(accessToken, roomId) {
  const res = await fetch(`${BASE_URL}/rooms/${roomId}/messages?after=${encodeCursor(0)}&limit=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`setup: poll failed ${res.status} ${await res.text()}`);
  return res.json();
}

function connectAndWait(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, {
      auth: { token },
      reconnection: false, // manual control — this script drives "reconnect" itself, deliberately
      timeout: 5000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitForAck(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message_ack')), timeoutMs);
    socket.once('message_ack', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  const alice = await registerFreshUser('reconnectqueue-alice');
  const room = await createRoom(alice.accessToken, 'reconnect-queue-room');

  // 1. In-flight at the moment of disconnect.
  console.log('1. Message emitted, connection killed before any ack could arrive, then resent on a fresh connection');
  {
    const clientMessageId = crypto.randomUUID();
    const firstSocket = await connectAndWait(alice.accessToken);

    // Emit and immediately kill the connection in the SAME synchronous
    // tick — no `await` between them — so there is no window in which a
    // real network round trip could have delivered an ack back to this
    // process before the transport is torn down. This is deliberately
    // more aggressive than a realistic "flaky wifi" disconnect: it proves
    // the guarantee even in the worst case, not just a plausible one.
    firstSocket.emit('send_message', { roomId: room.id, body: 'in flight when it dropped', clientMessageId });
    firstSocket.disconnect();

    // The outbox's own 'connect' handler is what would do this in the
    // browser — here it's done explicitly, since this script IS the thing
    // simulating a reconnect, not observing a real client's one.
    const secondSocket = await connectAndWait(alice.accessToken);
    const ackPromise = waitForAck(secondSocket);
    secondSocket.emit('send_message', { roomId: room.id, body: 'in flight when it dropped', clientMessageId });
    const ack = await ackPromise;

    check('resend on the fresh connection still gets acked', ack.client_message_id === clientMessageId);

    const page = await pollHttp(alice.accessToken, room.id);
    const matching = page.messages.filter((m) => m.client_message_id === clientMessageId);
    check('exactly one row exists for it, not zero and not two', matching.length === 1, matching.length);

    secondSocket.close();
  }

  // 2. Several messages queued while offline, replayed in order on reconnect.
  console.log('2. Multiple messages never sent on the first connection, replayed in order on the next one');
  {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const bodies = ['queued A', 'queued B', 'queued C'];
    // Deliberately no socket connection at all here — this simulates the
    // outbox accumulating entries while genuinely offline, not a
    // send-then-drop like case 1.

    const socket = await connectAndWait(alice.accessToken);
    const acks = [];
    socket.on('message_ack', (msg) => acks.push(msg));

    // Mirrors flushQueueOverSocket's own for-loop — emit every queued
    // entry, oldest first, without waiting for each one's ack before
    // sending the next. The small stagger between emits is NOT part of
    // that mirrored behavior (a real flush loop has none) — it exists
    // purely because this script runs against PGlite, which is
    // architecturally single-connection (see server/tests/setup/
    // globalSetup.ts's comment, and Phase 10's socket-messaging-test.mjs,
    // which hit the identical issue): three sendMessage() calls landing on
    // the same physical connection close enough together can throw
    // "Connection terminated unexpectedly," a PGlite/sandbox ceiling, not
    // a real Postgres one — Phase 4's concurrency-test.mjs already proved
    // genuine simultaneous sends are safe against a real Postgres pool.
    for (let i = 0; i < ids.length; i++) {
      socket.emit('send_message', { roomId: room.id, body: bodies[i], clientMessageId: ids[i] });
      await new Promise((r) => setTimeout(r, 50));
    }

    // Wait for all three acks to arrive rather than assuming a fixed delay.
    await new Promise((resolve) => {
      const pollForAcks = () => {
        if (acks.length >= ids.length) resolve();
        else setTimeout(pollForAcks, 50);
      };
      pollForAcks();
    });

    const orderedSequences = ids.map((id) => acks.find((a) => a.client_message_id === id)?.sequence_number);
    const isStrictlyIncreasing = orderedSequences.every(
      (seq, i) => i === 0 || (seq !== undefined && orderedSequences[i - 1] !== undefined && seq > orderedSequences[i - 1])
    );
    check(
      'all three got acked with strictly increasing sequence numbers, in the order sent',
      isStrictlyIncreasing,
      JSON.stringify(orderedSequences)
    );

    socket.close();
  }

  // 3. Resending a clientMessageId that was already fully acked is safe.
  console.log('3. Resending an already-acked message is still exactly-once and returns the SAME sequence number');
  {
    const clientMessageId = crypto.randomUUID();
    const socket = await connectAndWait(alice.accessToken);

    const firstAckPromise = waitForAck(socket);
    socket.emit('send_message', { roomId: room.id, body: 'already landed once', clientMessageId });
    const firstAck = await firstAckPromise;

    // Simulate the outbox re-flushing before it had processed the ack
    // that already arrived — e.g. a 'connect' handler firing again just
    // as an ack was in flight back to the client.
    const secondAckPromise = waitForAck(socket);
    socket.emit('send_message', { roomId: room.id, body: 'already landed once', clientMessageId });
    const secondAck = await secondAckPromise;

    check('both acks share the same id', firstAck.id === secondAck.id, `${firstAck.id} vs ${secondAck.id}`);
    check(
      'both acks share the same sequence_number',
      firstAck.sequence_number === secondAck.sequence_number,
      `${firstAck.sequence_number} vs ${secondAck.sequence_number}`
    );

    const page = await pollHttp(alice.accessToken, room.id);
    const matching = page.messages.filter((m) => m.client_message_id === clientMessageId);
    check('exactly one row exists for it', matching.length === 1, matching.length);

    socket.close();
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
