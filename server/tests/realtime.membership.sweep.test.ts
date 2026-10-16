import { describe, it, expect, afterEach, vi } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import { supertest } from './helpers/testApp';
import { startRealtimeServer, TestClient, sleep, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * Phase 16 exercise H2 - what if the revocation SIGNAL is lost?
 *
 * realtime.membership.test.ts proves the fast path: POST /leave announces on
 * the in-process bus and the socket layer evicts at once. But that announce is
 * an EDGE - it fires one time, and if it never arrives (an exception between
 * the DELETE and the announce; an instance dying in that window while another
 * instance holds the user's socket) nothing ever repeats it. Here the announce
 * is swallowed on purpose, and the question is how long the ex-member keeps
 * receiving:
 *   - without the sweep: forever (until their connection happens to drop);
 *   - with it: about one sweep interval, at a cost of one query per tick.
 *
 * (A single process that dies takes its sockets with it, and clients rejoin
 * through join_room, which re-checks the database - the first test ends by
 * showing that half too.)
 */
describe('membership sweep: bounded staleness when the revocation signal is lost', () => {
  const clients: TestClient[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (clients.length) clients.pop()!.close();
  });

  /** Bob leaves over HTTP but the fast-path announce is swallowed; Alice keeps talking. */
  async function lostSignalScenario(server: RealtimeServer) {
    const events = await import('../src/realtime/membershipEvents'); // same module instance as THIS server's graph
    vi.spyOn(events, 'announceMembershipRevoked').mockImplementation(() => undefined);

    const alice = await registerUser(server.url);
    const bob = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);
    await joinRoomOverHttp(server.url, bob.accessToken, roomId);
    const a = new TestClient(server.url, alice.accessToken);
    const b = new TestClient(server.url, bob.accessToken);
    clients.push(a, b);
    await a.connect();
    await b.connect();
    await a.join(roomId);
    await b.join(roomId);

    const res = await supertest(server.url).post(`/rooms/${roomId}/leave`).set('Authorization', `Bearer ${bob.accessToken}`);
    expect(res.status).toBe(204); // the DELETE committed; the announce never happened
    const leftAt = Date.now();

    let evictedAfterMs: number | null = null;
    let sent = 0;
    // 150 ms between sends keeps this well under the 10-message burst (2/s refill).
    while (Date.now() - leftAt < 1500) {
      await a.send(roomId, `msg ${sent++}`);
      await sleep(150);
      if (evictedAfterMs === null && b.events.some((e) => e.event === 'removed_from_room')) evictedAfterMs = Date.now() - leftAt;
    }

    const evictIdx = b.events.findIndex((e) => e.event === 'removed_from_room');
    const count = (events_: typeof b.events) => events_.filter((e) => e.event === 'new_message').length;
    return {
      roomId,
      bobToken: bob.accessToken,
      b,
      evictedAfterMs,
      sent,
      before: count(evictIdx === -1 ? b.events : b.events.slice(0, evictIdx)),
      after: evictIdx === -1 ? 0 : count(b.events.slice(evictIdx)),
    };
  }

  it('WITHOUT the sweep, the zombie hears everything until its connection drops - and a reconnect is refused', async () => {
    const server = await startRealtimeServer({ env: { MEMBERSHIP_SWEEP_INTERVAL_MS: '0' } });
    try {
      const r = await lostSignalScenario(server);
      expect(r.evictedAfterMs).toBeNull();
      expect(r.before).toBe(r.sent); // Bob heard EVERY message sent after he left

      // The "crash is benign" half: a fresh connection must pass join_room's database check.
      r.b.socket.disconnect();
      const bob2 = new TestClient(server.url, r.bobToken);
      clients.push(bob2);
      await bob2.connect();
      bob2.emit('join_room', { roomId: r.roomId });
      expect((await bob2.take('error')).error.code).toBe('FORBIDDEN');
    } finally {
      await server.close();
    }
  }, 30_000);

  it('WITH a 200 ms sweep, the zombie is evicted within about one interval and hears nothing afterwards', async () => {
    const server = await startRealtimeServer({ env: { MEMBERSHIP_SWEEP_INTERVAL_MS: '200' } });
    try {
      const r = await lostSignalScenario(server);
      expect(r.evictedAfterMs).not.toBeNull();
      expect(r.evictedAfterMs!).toBeLessThan(200 + 500); // interval + query + the test's own polling slack
      expect(r.after).toBe(0);
      expect(r.before).toBeLessThan(r.sent); // it did not hear the whole conversation
    } finally {
      await server.close();
    }
  }, 30_000);

  it('cost: ONE query per tick for the whole server - not per room, not per push', async () => {
    const server = await startRealtimeServer({ env: { MEMBERSHIP_SWEEP_INTERVAL_MS: '200' } });
    try {
      const alice = await registerUser(server.url);
      for (let i = 0; i < 5; i++) {
        const roomId = await createRoom(server.url, alice.accessToken);
        const c = new TestClient(server.url, alice.accessToken);
        clients.push(c);
        await c.connect();
        await c.join(roomId); // 5 sockets in 5 live rooms
      }
      const { pool } = await import('../src/db/pool');
      const spy = vi.spyOn(pool, 'query');
      await sleep(1050); // a quiet window: only the sweep ticks
      const sweepQueries = spy.mock.calls.filter((c) => String(c[0]).includes('unnest')).length;
      expect(sweepQueries).toBeGreaterThanOrEqual(4);
      expect(sweepQueries).toBeLessThanOrEqual(6);
      expect(spy.mock.calls.length - sweepQueries).toBe(0); // nothing else touched the database
    } finally {
      await server.close();
    }
  }, 30_000);
});
