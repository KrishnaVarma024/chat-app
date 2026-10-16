import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp, type RegisteredUser } from './helpers/fixtures';
import {
  startRealtimeServer,
  startProxy,
  TestClient,
  sleep,
  waitUntil,
  type RealtimeServer,
} from './helpers/realtimeHarness';

/**
 * Phase 16 — presence reference counting, the grace period, and heartbeat
 * detection of a connection that dies silently (ARCHITECTURE_V2.md §8, §9).
 *
 * Production values are a 7s grace period and a 25s+20s heartbeat — correct
 * for users, unusable for a test. The server reads them from env (env.ts),
 * so this file starts its own server with millisecond-scale values. The
 * LOGIC under test is identical; only the clock is compressed.
 */
const GRACE_MS = 300;
const PING_INTERVAL_MS = 250;
const PING_TIMEOUT_MS = 250;

describe('presence over a real port', () => {
  let server: RealtimeServer;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startRealtimeServer({
      env: {
        PRESENCE_GRACE_PERIOD_MS: String(GRACE_MS),
        SOCKET_PING_INTERVAL_MS: String(PING_INTERVAL_MS),
        SOCKET_PING_TIMEOUT_MS: String(PING_TIMEOUT_MS),
      },
    });
  });
  afterEach(() => {
    while (clients.length) clients.pop()!.close();
  });
  afterAll(async () => {
    await server.close();
  });

  async function connected(token: string, url = server.url): Promise<TestClient> {
    const c = new TestClient(url, token);
    clients.push(c);
    await c.connect();
    return c;
  }

  /** `watcher` is already in the room and has consumed nothing — so every
   * `presence` event it records from here on is attributable to `subject`. */
  async function watchedUser() {
    const subject = await registerUser(server.url);
    const watcherUser = await registerUser(server.url);
    const roomId = await createRoom(server.url, watcherUser.accessToken);
    await joinRoomOverHttp(server.url, subject.accessToken, roomId);
    const watcher = await connected(watcherUser.accessToken);
    await watcher.join(roomId);
    return { subject, watcher, roomId };
  }

  const isFor = (u: RegisteredUser, status: string) => (p: { userId: number; status: string }) =>
    p.userId === u.userId && p.status === status;

  it('two sockets, one user: online once; closing ONE changes nothing; closing the LAST goes offline only after the grace period', async () => {
    const { subject, watcher } = await watchedUser();

    const tab1 = await connected(subject.accessToken);
    await watcher.take('presence', isFor(subject, 'online'));

    const tab2 = await connected(subject.accessToken);
    expect(await watcher.collect('presence', 200)).toEqual([]); // second tab: not news

    tab1.close();
    // Comfortably longer than the grace period: if a lone close were treated
    // as "user left", the offline event would have fired by now.
    expect(await watcher.collect('presence', GRACE_MS * 2)).toEqual([]);

    const closedAt = Date.now();
    tab2.close();
    await watcher.take('presence', isFor(subject, 'offline'), 3000);
    const waited = Date.now() - closedAt;
    // Not instant (the grace period held it back)...
    expect(waited).toBeGreaterThanOrEqual(GRACE_MS * 0.8);
    // ...and not wildly late.
    expect(waited).toBeLessThan(GRACE_MS + 1500);
  });

  it('a reconnect inside the grace period broadcasts NOTHING — no offline, and no second online', async () => {
    const { subject, watcher } = await watchedUser();

    const first = await connected(subject.accessToken);
    await watcher.take('presence', isFor(subject, 'online'));

    // A page refresh: the old connection drops, a new one appears moments later.
    first.close();
    await sleep(GRACE_MS / 3);
    await connected(subject.accessToken);

    // To everyone watching, the user never left.
    expect(await watcher.collect('presence', GRACE_MS * 3)).toEqual([]);
  });

  it('a connection that dies SILENTLY is detected by the heartbeat, then goes offline after the grace period', async () => {
    const { subject, watcher } = await watchedUser();
    const proxy = await startProxy(server.port);
    try {
      await connected(subject.accessToken, proxy.url);
      await watcher.take('presence', isFor(subject, 'online'));

      // The socket stays OPEN at both ends; the bytes just stop. No FIN, no
      // RST — nothing the OS would notice for minutes.
      const cutAt = Date.now();
      proxy.blackhole();

      await watcher.take('presence', isFor(subject, 'offline'), 6000);
      const detected = Date.now() - cutAt;
      // Heartbeat window (interval + timeout) + grace period, with slack —
      // far from "whenever TCP gives up".
      expect(detected).toBeLessThan(PING_INTERVAL_MS + PING_TIMEOUT_MS + GRACE_MS + 2000);

      const record = server.disconnects.find((d) => d.userId === subject.userId);
      expect(record?.reason).toBe('ping timeout');
    } finally {
      await proxy.close();
    }
  });

  it('presence reaches only people sharing a room with the user', async () => {
    const { subject } = await watchedUser();
    const stranger = await registerUser(server.url);
    const strangerRoom = await createRoom(server.url, stranger.accessToken);
    const strangerClient = await connected(stranger.accessToken);
    await strangerClient.join(strangerRoom); // listening — but in a room the subject is not part of

    await connected(subject.accessToken);
    expect(await strangerClient.collect('presence', 300)).toEqual([]);
  });
});
