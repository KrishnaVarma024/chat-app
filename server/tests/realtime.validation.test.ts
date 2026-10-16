import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import { startRealtimeServer, TestClient, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * Phase 16 exercise B3 — an invalid `send_message` is rejected on the wire AND
 * leaves no trace in the database.
 *
 * "Rejected" has three observable halves, and a test that only checks the
 * first is checking the cheap one:
 *   1. the sender gets VALIDATION_ERROR carrying the SAME clientMessageId
 *      (so the client can find the optimistic bubble the error belongs to);
 *   2. no row exists for that id;
 *   3. no SEQUENCE NUMBER was consumed - validation must run before the
 *      transaction opens. A validator that ran after the counter upsert would
 *      leave gaps in the room's sequence for every bad payload.
 * Plus a bounded negative assertion: nobody else is told about it.
 */
describe('send_message validation over a real port', () => {
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

  const connected = async (token: string) => {
    const c = new TestClient(server.url, token);
    clients.push(c);
    await c.connect();
    return c;
  };

  const cases: Array<[string, (id: string) => Record<string, unknown>]> = [
    ['empty body', (id) => ({ body: '', clientMessageId: id })],
    ['body over 4000 chars', (id) => ({ body: 'x'.repeat(4001), clientMessageId: id })],
    ['body missing entirely', (id) => ({ clientMessageId: id })],
  ];

  it.each(cases)(
    '%s -> VALIDATION_ERROR echoing the clientMessageId; no row; sequence counter untouched; nothing pushed',
    async (_label, build) => {
      const alice = await registerUser(server.url);
      const bob = await registerUser(server.url);
      const roomId = await createRoom(server.url, alice.accessToken);
      await joinRoomOverHttp(server.url, bob.accessToken, roomId);
      const a = await connected(alice.accessToken);
      const b = await connected(bob.accessToken);
      await a.join(roomId);
      await b.join(roomId);

      // One VALID message first, so the counter has a known non-zero value to compare against.
      await a.send(roomId, 'baseline');
      await b.take('new_message');
      const counter = async () =>
        (await server.query('SELECT last_sequence FROM room_sequence_counters WHERE room_id=$1', [roomId])).rows[0].last_sequence;
      const counterBefore = await counter();

      const id = crypto.randomUUID();
      a.emit('send_message', { roomId, ...build(id) });

      const err = await a.take('error', (e: { clientMessageId?: string }) => e.clientMessageId === id);
      expect(err.error.code).toBe('VALIDATION_ERROR');
      expect(err.clientMessageId).toBe(id);

      const rows = (await server.query('SELECT 1 FROM messages WHERE room_id=$1 AND client_message_id=$2', [roomId, id])).rows;
      expect(rows).toHaveLength(0);
      expect(await counter()).toBe(counterBefore);

      expect(await b.collect('new_message', 150)).toHaveLength(0);
    }
  );

  it('a non-UUID clientMessageId is rejected too, and echoed verbatim so the client can still find its bubble', async () => {
    const alice = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);
    const a = await connected(alice.accessToken);
    await a.join(roomId);

    a.emit('send_message', { roomId, body: 'hi', clientMessageId: 'not-a-uuid' });
    const err = await a.take('error', (e: { clientMessageId?: string }) => e.clientMessageId === 'not-a-uuid');
    expect(err.error.code).toBe('VALIDATION_ERROR');
    expect((await server.query('SELECT count(*)::int AS n FROM messages WHERE room_id=$1', [roomId])).rows[0].n).toBe(0);
  });
});
