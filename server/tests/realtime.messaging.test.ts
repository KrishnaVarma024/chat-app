import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import { startRealtimeServer, TestClient, waitUntil, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * Phase 16 — the basic real-time contract, over a REAL port with a real
 * socket.io-client. Everything else in this directory's realtime.* files
 * builds on these guarantees, so they get proven first.
 */
describe('realtime messaging over a real port', () => {
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

  /** Connect sequentially — PGlite is single-connection, and this keeps the
   * per-connection username/presence lookups from racing each other. */
  async function connected(token: string | undefined, opts = {}): Promise<TestClient> {
    const c = new TestClient(server.url, token, opts);
    clients.push(c);
    await c.connect();
    return c;
  }

  async function roomWithTwoMembers() {
    const alice = await registerUser(server.url);
    const bob = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);
    await joinRoomOverHttp(server.url, bob.accessToken, roomId);
    const a = await connected(alice.accessToken);
    const b = await connected(bob.accessToken);
    await a.join(roomId);
    await b.join(roomId);
    return { alice, bob, roomId, a, b };
  }

  it('refuses a handshake with no token or a garbage token, and never creates a server-side socket', async () => {
    const before = server.io.sockets.sockets.size;

    await expect(new TestClient(server.url, undefined).connect()).rejects.toThrow('UNAUTHORIZED');
    await expect(new TestClient(server.url, 'not.a.jwt').connect()).rejects.toThrow('UNAUTHORIZED');

    expect(server.io.sockets.sockets.size).toBe(before);
  });

  it('the default transports (polling first) upgrade to a real WebSocket', async () => {
    const user = await registerUser(server.url);
    const c = await connected(user.accessToken, { transports: ['polling', 'websocket'] });
    // The upgrade happens just AFTER 'connect', so wait for it instead of
    // asserting immediately.
    await waitUntil(() => c.socket.io.engine.transport.name === 'websocket', 5000, 'polling -> websocket upgrade');
    expect(c.socket.io.engine.transport.name).toBe('websocket');
  });

  it('send_message: ack to the sender, new_message to everyone else, same row, consecutive sequences', async () => {
    const { alice, roomId, a, b } = await roomWithTwoMembers();

    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const acks = [];
    for (const [i, id] of ids.entries()) {
      acks.push(await a.send(roomId, `hello ${i + 1}`, id));
    }

    // Bob received each live push, in order, matching what Alice was acked.
    for (const [i, ack] of acks.entries()) {
      const pushed = await b.take('new_message', (m: { client_message_id: string }) => m.client_message_id === ids[i]);
      expect(pushed.sequence_number).toBe(ack.sequence_number);
      expect(pushed.body).toBe(`hello ${i + 1}`);
      expect(pushed.sender_username).toBe(alice.username);
    }
    expect(acks.map((m) => m.sequence_number)).toEqual([acks[0].sequence_number, acks[0].sequence_number + 1, acks[0].sequence_number + 2]);

    // The sender is NOT echoed their own message (socket.to excludes the origin).
    expect(await a.collect('new_message', 200)).toEqual([]);

    const rows = await server.query('SELECT count(*)::int AS n FROM messages WHERE room_id = $1', [roomId]);
    expect(rows.rows[0].n).toBe(3);
  });

  it('a non-member cannot join, cannot send, and receives nothing from the room', async () => {
    const { roomId, a } = await roomWithTwoMembers();
    const carol = await registerUser(server.url);
    const c = await connected(carol.accessToken);

    c.emit('join_room', { roomId });
    expect((await c.take('error')).error.code).toBe('FORBIDDEN');

    const id = crypto.randomUUID();
    c.emit('send_message', { roomId, body: 'let me in', clientMessageId: id });
    const err = await c.take('error');
    expect(err.error.code).toBe('FORBIDDEN');
    expect(err.clientMessageId).toBe(id); // the client can tell WHICH optimistic bubble failed

    await a.send(roomId, 'members only');
    expect(await c.collect('new_message', 200)).toEqual([]);
    const rows = await server.query('SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND body = $2', [roomId, 'let me in']);
    expect(rows.rows[0].n).toBe(0);
  });

  it('typing is relayed to other joined members only, never echoed, and refused for a room the socket has not joined', async () => {
    const { alice, roomId, a, b } = await roomWithTwoMembers();

    a.emit('typing_start', { roomId });
    expect(await b.take('typing', (p: { roomId: number }) => p.roomId === roomId)).toEqual({ userId: alice.userId, roomId });
    a.emit('typing_stop', { roomId });
    expect(await b.take('stopped_typing')).toEqual({ userId: alice.userId, roomId });
    expect(await a.collect('typing', 150)).toEqual([]);

    // A connected user who never joined this room can't spoof typing into it.
    const mallory = await registerUser(server.url);
    const m = await connected(mallory.accessToken);
    m.emit('typing_start', { roomId });
    expect((await m.take('error')).error.code).toBe('FORBIDDEN');
    expect(await b.collect('typing', 150)).toEqual([]);
  });
});
