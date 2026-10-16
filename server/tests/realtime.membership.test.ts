import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import { supertest } from './helpers/testApp';
import { startRealtimeServer, TestClient, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * Phase 16 — membership revocation reaches LIVE sockets (ARCHITECTURE_V2.md
 * §4/§5).
 *
 * v1's polling re-checked membership on every request, so leaving a room cut
 * access on the very next poll. A push model has no "next request": a socket
 * that already joined `room:7` keeps receiving room 7's messages until
 * something removes it from that Socket.IO room. This file is the test that
 * would have caught that regression — a user who has left (or been removed)
 * must stop receiving, immediately, on every connection they have open.
 */
describe('leaving a room evicts live sockets', () => {
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

  async function connected(token: string): Promise<TestClient> {
    const c = new TestClient(server.url, token);
    clients.push(c);
    await c.connect();
    return c;
  }

  const leaveOverHttp = (token: string, roomId: number) =>
    supertest(server.url).post(`/rooms/${roomId}/leave`).set('Authorization', `Bearer ${token}`);

  async function scene() {
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

  it('after POST /leave, the leaver receives no further messages, typing or presence from that room', async () => {
    const { bob, roomId, a, b } = await scene();

    // Sanity: before leaving, Bob is hearing the room.
    await a.send(roomId, 'before');
    await b.take('new_message', (m: { body: string }) => m.body === 'before');

    expect((await leaveOverHttp(bob.accessToken, roomId)).status).toBe(204);
    expect(await b.take('removed_from_room', (p: { roomId: number }) => p.roomId === roomId)).toEqual({ roomId });

    await a.send(roomId, 'after the leave');
    a.emit('typing_start', { roomId });
    expect(await b.collect('new_message', 300)).toEqual([]);
    expect(await b.collect('typing', 50)).toEqual([]);

    // And he can't speak into it from a stale socket either.
    b.emit('typing_start', { roomId });
    expect((await b.take('error')).error.code).toBe('FORBIDDEN');
    b.emit('send_message', { roomId, body: 'ghost', clientMessageId: crypto.randomUUID() });
    expect((await b.take('error')).error.code).toBe('FORBIDDEN');
  });

  it('evicts EVERY socket the user has open, and only that user', async () => {
    const { alice, bob, roomId, a, b: bobTab1 } = await scene();
    const bobTab2 = await connected(bob.accessToken);
    await bobTab2.join(roomId);
    const carol = await registerUser(server.url);
    await joinRoomOverHttp(server.url, carol.accessToken, roomId);
    const c = await connected(carol.accessToken);
    await c.join(roomId);

    await leaveOverHttp(bob.accessToken, roomId);
    await bobTab1.take('removed_from_room');
    await bobTab2.take('removed_from_room');

    await a.send(roomId, 'only members hear this');
    expect(await bobTab1.collect('new_message', 250)).toEqual([]);
    expect(await bobTab2.collect('new_message', 50)).toEqual([]);
    // Carol (still a member) is unaffected.
    expect((await c.take('new_message')).body).toBe('only members hear this');
    expect(alice.userId).not.toBe(bob.userId);
  });

  it("leaving one room does not touch the user's other rooms", async () => {
    const { alice, bob, roomId, b } = await scene();
    const otherRoom = await createRoom(server.url, alice.accessToken);
    await joinRoomOverHttp(server.url, bob.accessToken, otherRoom);
    await b.join(otherRoom);
    const a2 = await connected(alice.accessToken);
    await a2.join(otherRoom);

    await leaveOverHttp(bob.accessToken, roomId);
    await b.take('removed_from_room');

    await a2.send(otherRoom, 'still in this one');
    expect((await b.take('new_message')).body).toBe('still in this one');
  });

  it('rejoining over HTTP + socket restores delivery', async () => {
    const { alice, bob, roomId, a, b } = await scene();
    await leaveOverHttp(bob.accessToken, roomId);
    await b.take('removed_from_room');

    await joinRoomOverHttp(server.url, bob.accessToken, roomId);
    await b.join(roomId);
    await a.send(roomId, 'welcome back');
    expect((await b.take('new_message')).body).toBe('welcome back');
    expect(alice.userId).not.toBe(bob.userId);
  });

  it('a join that RACES a leave does not leave a zombie member in the room', async () => {
    const alice = await registerUser(server.url);
    const bob = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);
    await joinRoomOverHttp(server.url, bob.accessToken, roomId);
    const a = await connected(alice.accessToken);
    await a.join(roomId);
    const b = await connected(bob.accessToken);

    // Open the race on purpose: the FIRST membership check (Bob's join) is
    // allowed to pass, and then — before the handler goes on to socket.join —
    // Bob's membership ends and the eviction runs. At that instant Bob's
    // socket isn't in the room yet, so the eviction can't remove it; the join
    // then lands anyway. Without the post-join re-check, Bob is now a member
    // of the live room with no database row behind it.
    const real = server.rooms.checkRoomMembership;
    let raced = false;
    vi.spyOn(server.rooms, 'checkRoomMembership').mockImplementation(async (...args) => {
      await real(...args);
      if (!raced) {
        raced = true;
        await leaveOverHttp(bob.accessToken, roomId);
      }
    });

    b.emit('join_room', { roomId });
    expect((await b.take('error')).error.code).toBe('FORBIDDEN');

    vi.restoreAllMocks();
    await a.send(roomId, 'bob must not hear this');
    expect(await b.collect('new_message', 300)).toEqual([]);
    expect(await b.collect('joined_room', 50)).toEqual([]);
  });
});
