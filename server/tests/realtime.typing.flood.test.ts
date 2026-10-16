import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import { startRealtimeServer, startProxy, TestClient, sleep, type RealtimeServer, type TestProxy } from './helpers/realtimeHarness';

/**
 * Phase 16 exercise M3 - a defence that answers every attack is an amplifier.
 *
 * 5,000 `typing_start` events in about two seconds from one client. The limits
 * (typingStore: burst 10, refill 2/s) and the notice throttle (one
 * `rate_limited` per socket+event per retryAfterSeconds) give hard upper
 * bounds that this file derives and asserts, with the server's output measured
 * on the wire through a counting proxy rather than inferred:
 *
 *   events accepted   <= capacity + refill * elapsed          = 10 + 2 * ~2.1s  ~ 14
 *   notices sent      <= floor(elapsed / retryAfter) + 1      = 3
 *   bytes back to the flooder: a few hundred - against ~185 KB sent.
 *
 * Measured (with the throttle): 2 notices, 134 bytes back for 185,000 sent.
 * Mutation (notice on EVERY refused event): 4,987 notices and 334,129 bytes -
 * the server emitting 1.8x what it received, plus one warn log line each.
 * The byte ceiling below is what turns that regression red.
 */
describe('typing flood: the limiter must not become an amplifier', () => {
  let server: RealtimeServer;
  const proxies: TestProxy[] = [];
  const clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startRealtimeServer();
  });
  afterAll(async () => {
    for (const c of clients) c.close();
    for (const p of proxies) await p.close();
    await server.close();
  });

  it('5,000 typing_start in ~2s: a handful accepted, at most a few notices, almost nothing sent back, connection alive', async () => {
    const alice = await registerUser(server.url);
    const bob = await registerUser(server.url);
    const roomId = await createRoom(server.url, alice.accessToken);
    await joinRoomOverHttp(server.url, bob.accessToken, roomId);

    const aliceProxy = await startProxy(server.port);
    proxies.push(aliceProxy);
    const a = new TestClient(aliceProxy.url, alice.accessToken);
    const b = new TestClient(server.url, bob.accessToken);
    clients.push(a, b);
    await a.connect();
    await b.connect();
    await a.join(roomId);
    await b.join(roomId);
    await sleep(300); // let join/presence chatter settle before measuring
    const base = { ...aliceProxy.bytes };

    const TOTAL = 5000;
    const TICKS = 20;
    const t0 = Date.now();
    for (let tick = 0; tick < TICKS; tick++) {
      for (let i = 0; i < TOTAL / TICKS; i++) a.emit('typing_start', { roomId });
      await sleep(100);
    }
    const elapsedSeconds = (Date.now() - t0) / 1000;
    await sleep(500); // drain

    const notices = a.all('rate_limited') as Array<{ retryAfterSeconds: number }>;
    const retryAfter = notices[0]?.retryAfterSeconds ?? 1;
    const fanout = b.all('typing').length;
    const sentBytes = aliceProxy.bytes.clientToServer - base.clientToServer;
    const echoedBytes = aliceProxy.bytes.serverToClient - base.serverToClient;

    expect(a.socket.connected).toBe(true); // slow down, never get out
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices.length).toBeLessThanOrEqual(Math.floor(elapsedSeconds / retryAfter) + 2); // +1 bound, +1 timing slack
    expect(fanout).toBeLessThanOrEqual(10 + Math.ceil(2 * (elapsedSeconds + 0.5)) + 1); // burst + refill; the room sees a trickle, not 5,000
    expect(sentBytes).toBeGreaterThan(100_000); // the flood really happened
    expect(echoedBytes).toBeLessThan(5_000); // and the server did not echo it back
  }, 30_000);
});
