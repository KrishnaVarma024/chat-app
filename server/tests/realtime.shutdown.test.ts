import { describe, it, expect, afterEach } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp } from './helpers/fixtures';
import {
  startRealtimeServer,
  startProxy,
  TestClient,
  RoomFollower,
  waitUntil,
  type RealtimeServer,
  type TestProxy,
} from './helpers/realtimeHarness';
// The REAL client policy (dependency-free), driving the REAL server.
import { attachConnectionLifecycle } from '../../client/src/realtime/connectionLifecycle';

/**
 * Phase 16 — graceful shutdown, as a rolling deploy actually looks
 * (ARCHITECTURE_V2.md §14). Two server instances in one process, each from
 * its own module graph, sharing one database, behind a retargetable proxy
 * standing in for the platform's router:
 *
 *   1. traffic shifts to the NEW instance (proxy.setTarget),
 *   2. the OLD instance gets SIGTERM (the real createShutdownHandler, with a
 *      fake exit),
 *   3. its clients are told `server_shutdown`, and reconnect immediately —
 *      landing on the new instance, replaying what they missed.
 *
 * The contrast case is a connection that is simply cut with no notice: it
 * has to wait out the normal backoff. The gap between the two IS the feature.
 */
describe('graceful shutdown / rolling deploy over a real port', () => {
  const RECONNECT_DELAY_MS = 1500; // the "normal" backoff both cases are measured against
  const servers: RealtimeServer[] = [];
  const proxies: TestProxy[] = [];
  const clients: TestClient[] = [];
  const detachers: Array<() => void> = [];

  afterEach(async () => {
    while (detachers.length) detachers.pop()!();
    while (clients.length) clients.pop()!.close();
    while (proxies.length) await proxies.pop()!.close();
    while (servers.length) await servers.pop()!.close();
  });

  async function boot(opts = {}) {
    const s = await startRealtimeServer(opts);
    servers.push(s);
    return s;
  }

  /** A client that behaves like the app's: auto-reconnect with a (deliberately slow) backoff, the real lifecycle policy, and a room follower. */
  async function appLikeClient(url: string, token: string, roomId: number) {
    const client = new TestClient(url, token, {
      reconnection: true,
      reconnectionDelay: RECONNECT_DELAY_MS,
      reconnectionDelayMax: RECONNECT_DELAY_MS,
      randomizationFactor: 0,
    });
    clients.push(client);
    detachers.push(
      attachConnectionLifecycle(client.socket, {
        refreshAccessToken: async () => true,
        getAccessToken: () => token,
        flushOutbox: () => undefined,
      })
    );
    const view = new RoomFollower(client, roomId, 0);
    await client.connect();
    await client.take('joined_room');
    return { client, view };
  }

  async function deployScenario() {
    const oldInstance = await boot();
    const proxy = await startProxy(oldInstance.port);
    proxies.push(proxy);

    const alice = await registerUser(oldInstance.url);
    const bob = await registerUser(oldInstance.url);
    const roomId = await createRoom(oldInstance.url, alice.accessToken);
    await joinRoomOverHttp(oldInstance.url, bob.accessToken, roomId);

    const a = await appLikeClient(proxy.url, alice.accessToken, roomId);
    const b = await appLikeClient(proxy.url, bob.accessToken, roomId);
    return { oldInstance, proxy, roomId, a, b };
  }

  it('SIGTERM: clients are told, reconnect IMMEDIATELY to the new instance, and lose nothing', async () => {
    const { oldInstance, proxy, roomId, a, b } = await deployScenario();

    const sent: number[] = [];
    for (let i = 1; i <= 3; i++) sent.push((await a.client.send(roomId, `before deploy ${i}`)).sequence_number);
    await waitUntil(() => b.view.got.size === 3, 5000, 'bob to receive the first three');

    // --- the deploy ---
    const newInstance = await boot();
    proxy.setTarget(newInstance.port); // 1. traffic shifts
    const sigtermAt = Date.now();
    await oldInstance.triggerShutdown({ ackTimeoutMs: 1000 }); // 2. the old instance is told to stop

    // Every client heard it...
    await a.client.take('server_shutdown');
    await b.client.take('server_shutdown');
    // ...and the old instance ran the whole sequence and exited cleanly.
    expect(oldInstance.exitCodes).toEqual([0]);

    // 3. Both clients land on the NEW instance well inside the configured
    // backoff — the "told, so reconnect now" path, not the "assume failure,
    // wait" path.
    await b.client.take('connect', undefined, 4000);
    await a.client.take('connect', undefined, 4000);
    const reconnectedIn = Date.now() - sigtermAt;
    expect(reconnectedIn).toBeLessThan(RECONNECT_DELAY_MS * 0.8);
    await waitUntil(() => newInstance.io.sockets.sockets.size === 2, 3000, 'both clients on the new instance');

    // Nothing lost, nothing duplicated: the conversation just continues.
    sent.push((await a.client.send(roomId, 'after deploy')).sequence_number);
    await waitUntil(() => b.view.got.has(sent[3]), 5000, 'bob to receive the post-deploy message');
    expect(b.view.sequences).toEqual(sent);
    expect(b.view.arrivals).toEqual(sent);
  }, 30_000);

  it('CONTRAST — a connection cut with no notice waits out the normal backoff, and still loses nothing sent meanwhile', async () => {
    const { oldInstance, proxy, roomId, b } = await deployScenario();

    // Carol is connected DIRECTLY to the server, so the cut below doesn't touch her.
    const carolUser = await registerUser(oldInstance.url);
    await joinRoomOverHttp(oldInstance.url, carolUser.accessToken, roomId);
    const carol = new TestClient(oldInstance.url, carolUser.accessToken);
    clients.push(carol);
    await carol.connect();
    await carol.join(roomId);

    const cutAt = Date.now();
    proxy.cutAll(); // no server_shutdown, no goodbye
    await b.client.take('disconnect');

    // Messages sent while Bob is away.
    const missed: number[] = [];
    for (let i = 1; i <= 3; i++) missed.push((await carol.send(roomId, `while bob was cut off ${i}`)).sequence_number);

    await b.client.take('connect', undefined, 6000);
    const waited = Date.now() - cutAt;

    // Same machinery, same client — but it had to assume failure, so it paid
    // the full first-retry delay. This is what the notice saves.
    expect(waited).toBeGreaterThanOrEqual(RECONNECT_DELAY_MS * 0.9);
    expect(b.client.all('server_shutdown')).toHaveLength(0);

    // ...and the catch-up on rejoin delivered exactly what he missed.
    await waitUntil(() => b.view.got.size === 3, 5000, 'bob to catch up');
    expect(b.view.sequences).toEqual(missed);
  }, 30_000);

  it('one unresponsive client cannot hold the deploy hostage: shutdown waits the ack timeout, then proceeds', async () => {
    const instance = await boot();
    const user = await registerUser(instance.url);
    // A plain client that never acknowledges server_shutdown (no lifecycle attached).
    const mute = new TestClient(instance.url, user.accessToken);
    clients.push(mute);
    await mute.connect();

    const started = Date.now();
    await instance.triggerShutdown({ ackTimeoutMs: 400, hardTimeoutMs: 5000 });
    const took = Date.now() - started;

    expect(await mute.take('server_shutdown')).toBeTypeOf('function'); // it WAS told; it just never answered
    expect(took).toBeGreaterThanOrEqual(350); // it waited for the ack...
    expect(took).toBeLessThan(2500); // ...but only up to the timeout
    expect(instance.exitCodes).toEqual([0]);
  });

  it('after shutdown begins, /health says 503 and new connections are refused', async () => {
    const instance = await boot();
    const user = await registerUser(instance.url);
    const before = await fetch(`${instance.url}/health`);
    expect(before.status).toBe(200);

    // Hold the shutdown open on a client that will not ack, so the drain
    // window is long enough to observe.
    const mute = new TestClient(instance.url, user.accessToken);
    clients.push(mute);
    await mute.connect();
    const shutdown = instance.triggerShutdown({ ackTimeoutMs: 1500, hardTimeoutMs: 5000 });

    await mute.take('server_shutdown'); // shutdown is now definitely in progress
    const during = await fetch(`${instance.url}/health`);
    expect(during.status).toBe(503);
    expect(await during.json()).toEqual({ ok: false, shuttingDown: true });

    await shutdown;
    await expect(new TestClient(instance.url, user.accessToken).connect(2000)).rejects.toThrow();
  });
});
