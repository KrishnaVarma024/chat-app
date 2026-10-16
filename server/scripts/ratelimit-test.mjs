#!/usr/bin/env node
/**
 * Phase 15, part 1 — verifies "flooding send_message or typing_start gets
 * rate-limited (an event to that socket, not a disconnect) without
 * affecting other users" against a running server.
 *
 * What it proves:
 *   1. A flood of send_message from Alice earns a `rate_limited` event
 *      addressed to Alice's socket...
 *   2. ...and her socket is STILL connected afterwards, with the SAME
 *      socket id (a reconnect would mint a new one — that is how this
 *      script tells "refused" apart from "kicked and silently reconnected").
 *   3. The notice is itself throttled: a 200-event flood produces a tiny,
 *      bounded number of notices, not 200 (the limiter must not amplify).
 *   4. Only about `capacity` of the flood was actually processed
 *      (persisted), not all of it.
 *   5. Bob, in the same room, sends normally DURING Alice's flood and every
 *      one of his messages is accepted and delivered.
 *   6. The same holds for typing_start: Alice gets rate_limited, stays
 *      connected, and Bob's typing indicators still relay.
 *   7. After the advertised retryAfterSeconds, Alice can send again.
 *
 * Usage: API_URL=http://localhost:4000 node scripts/ratelimit-test.mjs
 *        (sandbox PGlite: FLOOD_PACE_MS=40 — see the comment on FLOOD_PACE_MS)
 */
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';

const BASE_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pause between the FIRST few flood events only (default 0 = a true no-gap
// flood, which is what real Postgres should be tested with). The sandbox's
// PGlite stand-in is single-connection and cannot run the ~10 accepted
// sends' transactions concurrently (every prior phase hit this and
// documented it), so there the script runs with FLOOD_PACE_MS=40 to space
// out only the events that will actually reach the database. The remaining
// ~190 events are still fired back-to-back — they are the ones the limiter
// refuses, which is what this script is about.
const FLOOD_PACE_MS = Number(process.env.FLOOD_PACE_MS ?? 0);
const PACED_EVENTS = 12;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS — ${label}`);
  else {
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
  if (!res.ok) throw new Error(`register failed ${res.status} ${await res.text()}`);
  return res.json();
}

async function createRoom(accessToken, name) {
  const res = await fetch(`${BASE_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create room failed ${res.status} ${await res.text()}`);
  return res.json();
}

async function joinRoomHttp(accessToken, roomId) {
  const res = await fetch(`${BASE_URL}/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`HTTP join failed ${res.status} ${await res.text()}`);
}

async function listMessages(accessToken, roomId) {
  const res = await fetch(`${BASE_URL}/rooms/${roomId}/messages?limit=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`list messages failed ${res.status}`);
  const body = await res.json();
  return body.messages;
}

/** Connect, collect the events this script cares about, resolve when connected. */
function connect(accessToken) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, { auth: { token: accessToken }, reconnection: false, timeout: 5000 });
    const events = { rate_limited: [], message_ack: [], new_message: [], typing: [], error: [], disconnects: [] };
    for (const name of ['rate_limited', 'message_ack', 'new_message', 'typing', 'error']) {
      socket.on(name, (p) => events[name].push(p));
    }
    socket.on('disconnect', (r) => events.disconnects.push(r));
    socket.once('connect', () => resolve({ socket, events }));
    socket.once('connect_error', reject);
  });
}

function joinRoom(socket, roomId) {
  return new Promise((resolve, reject) => {
    socket.once('joined_room', resolve);
    socket.once('error', reject);
    socket.emit('join_room', { roomId });
  });
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);
  const alice = await registerFreshUser('rlalice');
  await sleep(60);
  const bob = await registerFreshUser('rlbob');
  await sleep(60);
  const room = await createRoom(alice.accessToken, `rl-${Date.now()}`);
  await sleep(60);
  await joinRoomHttp(bob.accessToken, room.id);
  await sleep(60);
  const roomId = room.id;

  // Stagger connects/joins: this sandbox's PGlite tolerates concurrent setup poorly.
  const a = await connect(alice.accessToken);
  await sleep(80);
  await joinRoom(a.socket, roomId);
  await sleep(80);
  const b = await connect(bob.accessToken);
  await sleep(80);
  await joinRoom(b.socket, roomId);
  await sleep(80);
  // Let each connection's own background lookups (username, presence) finish
  // before the flood starts — on the sandbox's single-connection PGlite they
  // would otherwise overlap Alice's first accepted send.
  await sleep(600);
  const aliceSocketId = a.socket.id;
  const bobSocketId = b.socket.id;

  console.log('1. Flood send_message from Alice (200 events) while Bob sends normally');
  const FLOOD = 200;
  const floodEvent = (i) =>
    a.socket.emit('send_message', { roomId, body: `flood-${i}`, clientMessageId: randomUUID() });

  // Phase A: the first events — the ones the limiter will ACCEPT (bucket
  // capacity 10) and that therefore reach the database.
  for (let i = 0; i < PACED_EVENTS; i++) {
    floodEvent(i);
    if (FLOOD_PACE_MS > 0) await sleep(FLOOD_PACE_MS);
  }
  // Phase B: the other ~188 events — all refused — keep hammering in tight
  // bursts for ~1.1s, and Bob sends five ordinary messages DURING it.
  const bobSends = (async () => {
    await sleep(250); // let Alice's last accepted send clear the DB first (single-connection PGlite)
    for (let i = 0; i < 5; i++) {
      b.socket.emit('send_message', { roomId, body: `bob-${i}`, clientMessageId: randomUUID() });
      await sleep(150);
    }
  })();
  for (let i = PACED_EVENTS; i < FLOOD; i++) {
    floodEvent(i);
    if (i % 10 === 0) await sleep(60);
  }
  await bobSends;
  await sleep(1500);

  const sendNotices = a.events.rate_limited.filter((e) => e.event === 'send_message');
  check('Alice received a rate_limited event for send_message', sendNotices.length >= 1, JSON.stringify(a.events.rate_limited));
  check('notice carries a positive retryAfterSeconds', sendNotices[0] && sendNotices[0].retryAfterSeconds >= 1, JSON.stringify(sendNotices[0]));
  check('Alice was NOT disconnected', a.socket.connected && a.events.disconnects.length === 0, `disconnects=${a.events.disconnects}`);
  check('Alice kept the SAME socket id (no silent reconnect)', a.socket.id === aliceSocketId);
  check(`notices are throttled: ${sendNotices.length} notices for ${FLOOD} events (must be <= 3)`, sendNotices.length <= 3);
  const replies = a.events.message_ack.length + a.events.error.length;
  check(`no amplification: ${FLOOD} events produced only ${replies} replies in total (acks + errors; must be <= 14, i.e. capacity + a little refill)`, replies <= 14);
  check('no error replies at all (refused events are answered by the throttled rate_limited notice, nothing else)', a.events.error.length === 0, JSON.stringify(a.events.error.slice(0, 2)));

  const history = await listMessages(bob.accessToken, roomId);
  const aliceMsgs = history.filter((m) => String(m.body).startsWith('flood-')).length;
  const bobMsgs = history.filter((m) => String(m.body).startsWith('bob-')).length;
  check(`only about the bucket capacity of the flood was persisted (${aliceMsgs} of ${FLOOD}; expected 10-16)`, aliceMsgs >= 10 && aliceMsgs <= 16);
  check(`Alice got ${a.events.message_ack.length} acks, matching what was persisted`, a.events.message_ack.length === aliceMsgs);
  check("Bob's 5 sends during the flood were ALL acked", b.events.message_ack.length === 5, `acks=${b.events.message_ack.length}`);
  check("Bob's 5 messages are all persisted", bobMsgs === 5, `bobMsgs=${bobMsgs}`);
  check('Bob received no rate_limited event', b.events.rate_limited.length === 0);
  check("Bob's socket is untouched (same id, connected)", b.socket.connected && b.socket.id === bobSocketId);
  check("Alice received Bob's 5 messages via new_message despite her own flood", a.events.new_message.filter((m) => String(m.body).startsWith('bob-')).length === 5);

  console.log('\n2. Flood typing_start from Alice while Bob types normally');
  const typingBefore = b.events.typing.length;
  const aliceTypingBefore = a.events.typing.length;
  for (let i = 0; i < FLOOD; i++) a.socket.emit('typing_start', { roomId });
  b.socket.emit('typing_start', { roomId });
  await sleep(800);
  const typingNotices = a.events.rate_limited.filter((e) => e.event === 'typing_start');
  check('Alice received a rate_limited event for typing_start', typingNotices.length >= 1);
  check(`typing notices throttled (${typingNotices.length}, must be <= 3)`, typingNotices.length <= 3);
  check('Alice still connected, same socket id', a.socket.connected && a.socket.id === aliceSocketId);
  const relayedToBob = b.events.typing.length - typingBefore;
  check(`only ~capacity of Alice's typing events were relayed to Bob (${relayedToBob} of ${FLOOD}; expected 1-16)`, relayedToBob >= 1 && relayedToBob <= 16);
  check("Bob's typing_start was relayed to Alice despite Alice's flood", a.events.typing.length - aliceTypingBefore >= 1);
  check('Bob still has no rate_limited', b.events.rate_limited.length === 0);

  console.log('\n3. Recovery after the advertised window');
  await sleep(6000); // 2 tokens/s -> a handful of tokens refilled
  const acksBefore = a.events.message_ack.length;
  a.socket.emit('send_message', { roomId, body: 'after-recovery', clientMessageId: randomUUID() });
  await sleep(800);
  check('Alice can send again once the bucket has refilled (message_ack received)', a.events.message_ack.length === acksBefore + 1);

  a.socket.close();
  b.socket.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('script crashed:', e);
  process.exit(1);
});
