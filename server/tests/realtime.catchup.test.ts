import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import {
  startRealtimeServer,
  TestClient,
  RoomFollower,
  waitUntil,
  sleep,
  type RealtimeServer,
} from './helpers/realtimeHarness';

/**
 * Phase 16 — catch-up correctness (ARCHITECTURE_V2.md §7, §13).
 *
 * The claim under test is the one the whole project is built around: a
 * client that was away, or that joins at an awkward moment, ends up with
 * EXACTLY the messages that exist — no gaps, and (after the client's own
 * dedupe) no duplicates. "It eventually arrives" is not the bar.
 */
describe('catch-up over a real port', () => {
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

  it('a gap larger than one page arrives complete and in order, then live delivery resumes seamlessly', async () => {
    const { alice, bob, roomId } = await newRoom();
    const seeded = await server.seedMessages(roomId, alice.userId, 120);

    // Bob has never seen this room: joining with sinceSequence 0 asks for ALL of it.
    const bobClient = new TestClient(server.url, bob.accessToken);
    clients.push(bobClient);
    const bobView = new RoomFollower(bobClient, roomId, 0);
    await bobClient.connect();

    await waitUntil(() => bobView.got.size >= 120, 10_000, 'all 120 seeded messages');
    expect(bobView.sequences).toEqual(seeded);
    // 120 messages at 50 per page = 3 batches. No message delivered twice.
    expect(bobClient.all('catch_up').map((b: any) => [b.messages.length, b.hasMore])).toEqual([
      [50, true],
      [50, true],
      [20, false],
    ]);
    expect(bobView.arrivals).toHaveLength(120);

    // And the seam is clean: the very next message arrives live, exactly once.
    const aliceClient = await connected(alice.accessToken);
    await aliceClient.join(roomId);
    const ack = await aliceClient.send(roomId, 'after the catch-up');
    await waitUntil(() => bobView.got.has(ack.sequence_number), 5000, 'the live message after catch-up');
    expect(bobView.sequences).toEqual([...seeded, ack.sequence_number]);
    expect(bobView.arrivals).toHaveLength(121);
  });

  it('a client whose connection drops receives exactly the messages it missed — the same set a live client saw', async () => {
    const { alice, bob, roomId } = await newRoom();
    const aliceClient = await connected(alice.accessToken);
    await aliceClient.join(roomId);

    const bobClient = new TestClient(server.url, bob.accessToken, {
      reconnection: true,
      reconnectionDelay: 50,
      reconnectionDelayMax: 100,
      randomizationFactor: 0,
    });
    clients.push(bobClient);
    const bobView = new RoomFollower(bobClient, roomId, 0);
    await bobClient.connect();
    await bobClient.take('joined_room');

    const sent: number[] = [];
    for (let i = 1; i <= 3; i++) sent.push((await aliceClient.send(roomId, `before ${i}`)).sequence_number);
    await waitUntil(() => bobView.got.size === 3, 5000, 'bob to receive the first three live');

    // A network drop from Bob's side: kill the transport under him. (Not
    // socket.disconnect() — that is a deliberate client-side close, which
    // Socket.IO never auto-reconnects from.)
    bobClient.socket.io.engine.close();
    await bobClient.take('disconnect');

    for (let i = 1; i <= 5; i++) sent.push((await aliceClient.send(roomId, `while bob was gone ${i}`)).sequence_number);

    // Auto-reconnect -> the follower rejoins with its cursor -> catch_up.
    await bobClient.take('connect');
    await waitUntil(() => bobView.got.size === 8, 5000, 'bob to catch up on the five he missed');

    sent.push((await aliceClient.send(roomId, 'after reconnect')).sequence_number);
    await waitUntil(() => bobView.got.size === 9, 5000, 'the live message after reconnecting');

    expect(bobView.sequences).toEqual(sent);
    // Nothing delivered twice: the cursor was exactly the high-water mark.
    expect(bobView.arrivals).toEqual(sent);
  });

  it('a message committed BETWEEN the catch-up query and the join is not lost (the seam)', async () => {
    const { alice, bob, roomId } = await newRoom();
    const seeded = await server.seedMessages(roomId, alice.userId, 3);
    const aliceClient = await connected(alice.accessToken);
    await aliceClient.join(roomId);

    // Deterministically open the window: let the REAL catch-up query run,
    // then — before its result is handed back to the join handler — have
    // Alice send a message and wait for it to commit and fan out. In
    // production this is "a message lands in the few milliseconds between
    // Bob's SELECT and Bob's join"; here it happens every time.
    const real = server.repo.listMessagesAfter;
    let injected: number | undefined;
    vi.spyOn(server.repo, 'listMessagesAfter').mockImplementation(async (...args) => {
      const snapshot = await real(...args);
      if (injected === undefined) {
        injected = (await aliceClient.send(roomId, 'sent inside the seam')).sequence_number;
        await sleep(100); // let the broadcast to the room finish
      }
      return snapshot;
    });

    const bobClient = new TestClient(server.url, bob.accessToken);
    clients.push(bobClient);
    const bobView = new RoomFollower(bobClient, roomId, 0);
    await bobClient.connect();
    await bobClient.take('joined_room');
    await sleep(200); // anything in flight has landed

    expect(injected).toBeDefined();
    // Whether it came from the snapshot or from the live push is irrelevant —
    // what matters is that Bob has it.
    expect(bobView.sequences).toEqual([...seeded, injected!]);
  });

  it('live messages interleaved with a multi-page catch-up never make the client skip a page', async () => {
    const { alice, bob, roomId } = await newRoom();
    const seeded = await server.seedMessages(roomId, alice.userId, 120);
    const aliceClient = await connected(alice.accessToken);
    await aliceClient.join(roomId);

    // While Bob's FIRST page is being fetched, Alice sends. Bob is already in
    // the room (join-then-query), so the new message is pushed live and
    // arrives BEFORE page 1 — carrying a sequence number far above anything
    // Bob has caught up to. A client that treated "highest seen" as its
    // cursor would jump to 121 and ask for "everything after 121" next,
    // silently skipping 51..120.
    const real = server.repo.listMessagesAfter;
    let live: number | undefined;
    vi.spyOn(server.repo, 'listMessagesAfter').mockImplementation(async (...args) => {
      const page = await real(...args);
      if (live === undefined) {
        live = (await aliceClient.send(roomId, 'live during catch-up')).sequence_number;
        await sleep(100);
      }
      return page;
    });

    const bobClient = new TestClient(server.url, bob.accessToken);
    clients.push(bobClient);
    const bobView = new RoomFollower(bobClient, roomId, 0);
    await bobClient.connect();

    await waitUntil(() => bobView.got.size >= 121, 10_000, 'every message, including the live one');
    expect(bobView.sequences).toEqual([...seeded, live!]);
    // The live message really did arrive first — that is what made this a test.
    expect(bobView.arrivals[0]).toBe(live);
  });

  it('joining past the latest sequence is an empty, well-formed batch; bad cursors and non-members are refused', async () => {
    const { alice, bob, roomId } = await newRoom();
    const seeded = await server.seedMessages(roomId, alice.userId, 2);
    const last = seeded[seeded.length - 1];

    const bobClient = await connected(bob.accessToken);
    await bobClient.join(roomId, last + 100);
    expect(await bobClient.take('catch_up')).toMatchObject({
      roomId,
      messages: [],
      hasMore: false,
      latestSequenceNumber: last + 100, // echoes the cursor: "you are caught up"
    });

    bobClient.emit('join_room', { roomId, sinceSequence: -1 });
    expect((await bobClient.take('error')).error.code).toBe('VALIDATION_ERROR');
    bobClient.emit('join_room', { roomId, sinceSequence: 1.5 });
    expect((await bobClient.take('error')).error.code).toBe('VALIDATION_ERROR');

    // A non-member gets a FORBIDDEN and — crucially — no batch of someone else's history.
    const carol = await registerUser(server.url);
    const carolClient = await connected(carol.accessToken);
    carolClient.emit('join_room', { roomId, sinceSequence: 0 });
    expect((await carolClient.take('error')).error.code).toBe('FORBIDDEN');
    expect(await carolClient.collect('catch_up', 150)).toEqual([]);
  });

  it("another room's messages never leak into a catch-up", async () => {
    const { alice, bob, roomId } = await newRoom();
    const otherRoom = await createRoom(server.url, alice.accessToken);
    const mine = await server.seedMessages(roomId, alice.userId, 2, 'mine');
    await server.seedMessages(otherRoom, alice.userId, 5, 'theirs');

    const bobClient = await connected(bob.accessToken);
    await bobClient.join(roomId, 0);
    const batch = await bobClient.take('catch_up');
    expect(batch.messages.map((m: any) => m.sequence_number)).toEqual(mine);
    expect(batch.messages.every((m: any) => m.body.startsWith('mine'))).toBe(true);
  });
});
