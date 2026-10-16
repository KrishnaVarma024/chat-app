import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, createRoom } from './helpers/fixtures';
import { startRealtimeServer, TestClient, deferred, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * Phase 16 exercise M1 - exactly-once at BOTH ends of the commit, by
 * construction instead of by luck.
 *
 * realtime.replay.test.ts sweeps the cut point across 0/3/10/30 ms and hopes
 * to land on both sides of the COMMIT. This file replaces the hope with a gate:
 * `vi.spyOn(server.repo, 'sendMessage')` parks the handler at an exact point
 * (before the transaction opens / after it committed but before the ack), the
 * test cuts the connection there, resends, and asserts one row.
 *
 * What the cut can look like to the client is always the same - "no ack" - but
 * the server-side state differs completely:
 *   - after the commit: the row EXISTS; the retry must find it, not add one;
 *   - before the DB work: the row does NOT exist yet; the retry commits first
 *     and the original, resumed later, must collapse into it.
 */
describe('exactly-once across a cut, forced into each interleaving', () => {
  let server: RealtimeServer;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startRealtimeServer();
  });
  afterEach(() => {
    vi.restoreAllMocks();
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
  const rowsFor = async (roomId: number, id: string) =>
    (await server.query('SELECT sequence_number FROM messages WHERE room_id=$1 AND client_message_id=$2', [roomId, id])).rows;
  const counter = async (roomId: number) =>
    (await server.query('SELECT last_sequence FROM room_sequence_counters WHERE room_id=$1', [roomId])).rows[0].last_sequence as number;

  it('cut AFTER the commit, BEFORE the ack: the client never saw an ack, yet the retry returns the SAME row', async () => {
    const alice = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);

    const real = server.repo.sendMessage;
    const committed = deferred();
    const gate = deferred();
    vi.spyOn(server.repo, 'sendMessage').mockImplementationOnce(async (p) => {
      const row = await real(p); // the INSERT is durably COMMITTED here...
      committed.resolve();
      await gate.promise; // ...but the handler is frozen before it can ack
      return row;
    });

    const id = crypto.randomUUID();
    const doomed = await connected(alice.accessToken);
    await doomed.join(roomId);
    doomed.emit('send_message', { roomId, body: 'in the gap', clientMessageId: id });
    await committed.promise; // not "after 10ms": "after the commit"
    expect(await rowsFor(roomId, id)).toHaveLength(1);

    doomed.socket.disconnect();
    await vi.waitFor(() => expect(server.disconnects.length).toBeGreaterThan(0));
    gate.resolve(); // let the orphaned handler finish into a dead socket
    expect(doomed.all('message_ack')).toHaveLength(0); // proves the cut really fell in the gap

    const retry = await connected(alice.accessToken);
    await retry.join(roomId);
    const ack = await retry.send(roomId, 'in the gap', id);

    const rows = await rowsFor(roomId, id);
    expect(rows).toHaveLength(1);
    expect(ack.sequence_number).toBe(rows[0].sequence_number);
    // The documented price (messages.repo.ts): the retry claimed a sequence number it never used.
    expect(await counter(roomId)).toBe(rows[0].sequence_number + 1);
  });

  it('cut BEFORE the handler touches the DB, and the retry OVERTAKES the original: still one row', async () => {
    const alice = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);

    const real = server.repo.sendMessage;
    const entered = deferred();
    const gate = deferred();
    vi.spyOn(server.repo, 'sendMessage').mockImplementationOnce(async (p) => {
      entered.resolve();
      await gate.promise; // frozen BEFORE the transaction opens
      return real(p);
    });

    const id = crypto.randomUUID();
    const doomed = await connected(alice.accessToken);
    await doomed.join(roomId);
    doomed.emit('send_message', { roomId, body: 'overtaken', clientMessageId: id });
    await entered.promise;
    doomed.socket.disconnect();

    const retry = await connected(alice.accessToken);
    await retry.join(roomId);
    const ack = await retry.send(roomId, 'overtaken', id); // the SECOND attempt commits first (the spy was once-only)
    expect(await rowsFor(roomId, id)).toHaveLength(1);

    gate.resolve(); // now the ORIGINAL runs, collides on (room, sender, client_message_id), and must collapse
    await vi.waitFor(async () => expect(await counter(roomId)).toBe(ack.sequence_number + 1)); // it ran (and burned one)
    const rows = await rowsFor(roomId, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence_number).toBe(ack.sequence_number);
  });
});
