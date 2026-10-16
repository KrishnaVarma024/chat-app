import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import { startRealtimeServer, TestClient, RoomFollower, deferred, waitUntil, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * Phase 16 exercise H1 - live pushes that OVERTAKE each other must not make
 * the client's cursor skip a message.
 *
 * Sequence numbers are assigned in COMMIT order (the counter row's lock is
 * held until commit), but the broadcast happens after the handler resumes -
 * and two senders' handlers can resume in either order. So the room can be
 * told "seq 2" before it is told "seq 1".
 *
 * The scenario, forced deterministically with a gate on the first
 * `sendMessage`:
 *   1. Alice's X commits as seq 1, then her handler is frozen before it can
 *      broadcast.
 *   2. Bob's Y commits as seq 2 and is broadcast at once - it overtakes X.
 *   3. Carol (driving the SHIPPED client cursor) receives seq 2 and drops
 *      before X's broadcast goes out.
 *   4. X is finally broadcast - to a room Carol is no longer in.
 *   5. Carol reconnects with her cursor as `sinceSequence`.
 * With a "newest message seen" cursor she asks for "> 2" and seq 1 is gone
 * for good. With the contiguity watermark she asks for "> 0" and gets both.
 *
 * (No duplicate retries are involved - the bug does not need burned sequence
 * numbers, which is why "stop burning numbers" is not the fix.)
 */
describe('catch-up when live pushes arrive out of commit order', () => {
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

  it('X commits first (seq 1) but is broadcast late; Y (seq 2) overtakes it; Carol drops in between -> she still ends up with BOTH', async () => {
    const alice = await registerUser(server.url);
    const bob = await registerUser(server.url);
    const carol = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);
    await joinRoomOverHttp(server.url, bob.accessToken, roomId);
    await joinRoomOverHttp(server.url, carol.accessToken, roomId);

    const a = await connected(alice.accessToken);
    const b = await connected(bob.accessToken);
    await a.join(roomId);
    await b.join(roomId);

    const carolClient = new TestClient(server.url, carol.accessToken);
    clients.push(carolClient);
    const carolView = new RoomFollower(carolClient, roomId, 0); // the REAL client cursor
    await carolClient.connect();
    await carolClient.take('joined_room');

    // Alice's send: COMMIT (seq 1), then freeze the handler before it can broadcast.
    const real = server.repo.sendMessage;
    const committed = deferred();
    const gate = deferred();
    vi.spyOn(server.repo, 'sendMessage').mockImplementationOnce(async (p) => {
      const row = await real(p);
      committed.resolve();
      await gate.promise;
      return row;
    });
    a.emit('send_message', { roomId, body: 'X', clientMessageId: crypto.randomUUID() });
    await committed.promise;

    // Bob's send commits as seq 2 and is broadcast IMMEDIATELY - it overtakes X.
    const y = await b.send(roomId, 'Y');
    expect(y.sequence_number).toBe(2);
    await waitUntil(() => carolView.sequences.join() === '2', 3000, 'Carol receives Y (seq 2) first');

    // Carol's network drops before X's broadcast goes out...
    carolClient.socket.disconnect();
    await waitUntil(() => server.disconnects.some((d) => d.userId === carol.userId), 3000, 'server notices Carol is gone');
    gate.resolve(); // ...and only now does X's handler resume and broadcast - to a room Carol is not in.
    await a.take('message_ack');

    carolClient.socket.connect(); // RoomFollower rejoins with sinceSequence = her cursor
    await carolClient.take('joined_room');
    await vi.waitFor(() => expect(carolView.sequences).toEqual([1, 2]), { timeout: 3000 });
  });
});
