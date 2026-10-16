import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import { startRealtimeServer, TestClient, sleep, waitUntil, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * Phase 16 — reconnect-and-replay, proven EXACTLY-ONCE (ARCHITECTURE_V2.md
 * §6, §13). Not "the message eventually arrives": the database holds one row
 * no matter how many times the client re-sent it, because the client sends
 * a stable `client_message_id` and the server's INSERT is idempotent on it.
 *
 * The client-side outbox itself (localStorage persistence, in-memory order)
 * is covered by client/src/realtime/outbox.test.ts; this file proves the half
 * only a real server can: whatever the outbox replays, the server collapses.
 */
describe('reconnect-and-replay over a real port', () => {
  let server: RealtimeServer;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startRealtimeServer();
  });
  afterEach(() => {
    while (clients.length) clients.pop()!.close();
  });
  afterAll(async () => {
    await server.close();
  });

  async function connected(token: string, opts = {}): Promise<TestClient> {
    const c = new TestClient(server.url, token, opts);
    clients.push(c);
    await c.connect();
    return c;
  }

  async function newRoom() {
    const alice = await registerUser(server.url);
    const bob = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);
    await joinRoomOverHttp(server.url, bob.accessToken, roomId);
    return { alice, bob, roomId };
  }

  const rowsFor = async (roomId: number, clientMessageId: string) =>
    (
      await server.query('SELECT sequence_number FROM messages WHERE room_id = $1 AND client_message_id = $2', [
        roomId,
        clientMessageId,
      ])
    ).rows;

  it('resending an ALREADY-ACKED message on a fresh connection returns the same row, not a new one', async () => {
    const { alice, roomId } = await newRoom();
    const id = crypto.randomUUID();

    const first = await connected(alice.accessToken);
    await first.join(roomId);
    const original = await first.send(roomId, 'only once', id);
    first.close();

    const second = await connected(alice.accessToken);
    await second.join(roomId);
    const replayed = await second.send(roomId, 'only once', id);

    expect(replayed.id).toBe(original.id);
    expect(replayed.sequence_number).toBe(original.sequence_number);
    expect(await rowsFor(roomId, id)).toHaveLength(1);
  });

  it('a message in flight at the instant of disconnect lands exactly once, whichever side of the commit the cut fell on', async () => {
    const { alice, roomId } = await newRoom();

    // The cut can fall (a) before the server read the frame, (b) mid-handler,
    // or (c) after the commit but before the ack reached the client. The
    // client cannot tell which — so the invariant has to hold for all of
    // them. Sweep the cut point across the handler's lifetime. (Four cut
    // points = eight sends: deliberately under the 10-message rate-limit
    // burst, so this test is about idempotency, not throttling.)
    for (const cutAfterMs of [0, 3, 10, 30]) {
      const id = crypto.randomUUID();
      const doomed = await connected(alice.accessToken);
      await doomed.join(roomId);
      doomed.emit('send_message', { roomId, body: `cut after ${cutAfterMs}ms`, clientMessageId: id });
      if (cutAfterMs > 0) await sleep(cutAfterMs);
      doomed.socket.disconnect();

      // The outbox's contract: not acked => still queued => resend on connect.
      const retry = await connected(alice.accessToken);
      await retry.join(roomId);
      const ack = await retry.send(roomId, `cut after ${cutAfterMs}ms`, id);

      const rows = await rowsFor(roomId, id);
      expect(rows, `cut after ${cutAfterMs}ms`).toHaveLength(1);
      expect(rows[0].sequence_number).toBe(ack.sequence_number);
      retry.close();
    }
  });

  it('messages queued while offline replay in order on reconnect, once each — even if the flush runs twice', async () => {
    const { alice, bob, roomId } = await newRoom();
    const watcher = await connected(alice.accessToken);
    await watcher.join(roomId);

    const bobClient = new TestClient(server.url, bob.accessToken, {
      reconnection: true,
      reconnectionDelay: 50,
      reconnectionDelayMax: 100,
      randomizationFactor: 0,
    });
    clients.push(bobClient);
    await bobClient.connect();
    await bobClient.join(roomId);

    // Bob's network drops...
    bobClient.socket.io.engine.close();
    await bobClient.take('disconnect');

    // ...and while it is down he "sends" five messages: they go in the outbox, not on the wire.
    const outbox = Array.from({ length: 5 }, (_, i) => ({ id: crypto.randomUUID(), body: `queued ${i + 1}` }));
    const flush = () => {
      for (const m of outbox) bobClient.emit('send_message', { roomId, body: m.body, clientMessageId: m.id });
    };

    // On reconnect the client rejoins and flushes. Do it TWICE, as a
    // reconnect storm (a flapping network firing 'connect' repeatedly) would.
    await bobClient.take('connect');
    flush();
    flush();

    await waitUntil(
      () =>
        new Set(bobClient.all('message_ack').map((m: any) => m.client_message_id)).size >= 5 &&
        new Set(watcher.all('new_message').map((m: any) => m.client_message_id)).size >= 5,
      8000,
      'five distinct acks and five distinct pushes'
    );
    await sleep(150); // let any (wrongly) duplicated work from the second flush surface

    const stored = await server.query(
      'SELECT body, sequence_number FROM messages WHERE room_id = $1 ORDER BY sequence_number',
      [roomId]
    );
    // Exactly five rows, in the order they were queued, strictly increasing.
    expect(stored.rows.map((r: any) => r.body)).toEqual(outbox.map((m) => m.body));
    const seqs = stored.rows.map((r: any) => r.sequence_number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(5);

    // What the watcher saw. A duplicate send is answered with the original
    // row AND re-broadcast (at-least-once fan-out: if the first attempt
    // committed but the server died before broadcasting, the retry is what
    // delivers it) — so the watcher may legitimately see a push twice, and
    // every client dedupes by client_message_id (mergeMessages). What must
    // hold is the SET and the first-arrival ORDER: five distinct messages,
    // in the order they were queued, and never a sixth.
    const pushed = watcher.all('new_message') as Array<{ client_message_id: string; body: string }>;
    const firstArrivals = [...new Map(pushed.map((m) => [m.client_message_id, m.body])).values()];
    expect(firstArrivals).toEqual(outbox.map((m) => m.body));
    expect(new Set(pushed.map((m) => m.client_message_id)).size).toBe(5);
  });
});
