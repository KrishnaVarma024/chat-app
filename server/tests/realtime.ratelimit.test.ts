import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { registerUser, createRoom, joinRoomOverHttp, type RegisteredUser } from './helpers/fixtures';
import { supertest } from './helpers/testApp';
import { startRealtimeServer, TestClient, sleep, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * Phase 16 — socket rate limiting end to end (ARCHITECTURE_V2.md §11).
 *
 * The limits themselves (capacity 10, refill 2/s for messages and typing) are
 * unit-tested in bucketStore.test.ts / socketRateLimit.test.ts with fake
 * clocks. What only a real socket can show is the CONTRACT around them: a
 * refused event gets one `rate_limited` notice (not a flood of them), the
 * connection survives, refused work never reaches the database, the budget
 * belongs to the USER (not the socket), and it recovers on schedule.
 */
describe('rate limiting over a real port', () => {
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

  async function connected(token: string): Promise<TestClient> {
    const c = new TestClient(server.url, token);
    clients.push(c);
    await c.connect();
    return c;
  }

  async function joinedUser(): Promise<{ user: RegisteredUser; roomId: number; client: TestClient }> {
    const user = await registerUser(server.url);
    const roomId = await createRoom(server.url, user.accessToken);
    const client = await connected(user.accessToken);
    await client.join(roomId);
    return { user, roomId, client };
  }

  it('a send flood: the excess gets ONE rate_limited notice, the connection survives, refused sends never touch the DB, and the budget recovers', async () => {
    const { user, roomId, client } = await joinedUser();

    // 25 sends in one tick — far past the burst of 10.
    const ids = Array.from({ length: 25 }, () => crypto.randomUUID());
    ids.forEach((id, i) => client.emit('send_message', { roomId, body: `flood ${i}`, clientMessageId: id }));

    const notice = await client.take('rate_limited', (n: { event: string }) => n.event === 'send_message');
    expect(notice.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    await sleep(1200); // let every ALLOWED send finish its DB round trip
    const acked = new Set(client.all('message_ack').map((m: any) => m.client_message_id));
    expect(acked.size).toBeGreaterThanOrEqual(10);
    expect(acked.size).toBeLessThan(25);

    // One notice for the whole flood — not one per refused event. (Answering
    // a flood with a flood of replies would make the limiter an amplifier.)
    expect(client.all('rate_limited').filter((n: any) => n.event === 'send_message')).toHaveLength(1);

    // A rate limit is "slow down", never "get out".
    expect(client.socket.connected).toBe(true);
    expect(server.disconnects.filter((d) => d.userId === user.userId)).toEqual([]);

    // Refused events cost nothing downstream: the table holds exactly the acked ids.
    const stored = await server.query('SELECT client_message_id FROM messages WHERE room_id = $1', [roomId]);
    expect(new Set(stored.rows.map((r: any) => r.client_message_id))).toEqual(acked);

    // The advertised wait is honest: after it, a refused message goes through.
    await sleep(notice.retryAfterSeconds * 1000 + 100);
    const refusedId = ids.find((id) => !acked.has(id))!;
    const retry = await client.send(roomId, 'retried after the notice', refusedId);
    expect(retry.client_message_id).toBe(refusedId);
  });

  it('the budget belongs to the USER, not the connection: a second socket gets no fresh allowance', async () => {
    const user = await registerUser(server.url);
    const observerUser = await registerUser(server.url);
    const roomId = await createRoom(server.url, observerUser.accessToken);
    await joinRoomOverHttp(server.url, user.accessToken, roomId);

    const observer = await connected(observerUser.accessToken);
    await observer.join(roomId);
    const tab1 = await connected(user.accessToken);
    await tab1.join(roomId);
    const tab2 = await connected(user.accessToken);
    await tab2.join(roomId);

    // 15 typing events from EACH tab. Typing does no DB work, so the whole
    // thing resolves in milliseconds and the refill barely matters.
    for (let i = 0; i < 15; i++) tab1.emit('typing_start', { roomId });
    for (let i = 0; i < 15; i++) tab2.emit('typing_start', { roomId });

    await tab1.take('rate_limited', (n: { event: string }) => n.event === 'typing_start');
    await tab2.take('rate_limited', (n: { event: string }) => n.event === 'typing_start');

    await sleep(300);
    const relayed = observer.all('typing').length;
    // One bucket of 10 (plus a sliver of refill) for the user's TWO tabs. A
    // per-socket bucket would have relayed 20.
    expect(relayed).toBeGreaterThanOrEqual(10);
    expect(relayed).toBeLessThanOrEqual(12);
    expect(tab1.all('rate_limited')).toHaveLength(1);
    expect(tab2.all('rate_limited')).toHaveLength(1);
  });

  it('HTTP and socket spend from the same send budget', async () => {
    const { user, roomId, client } = await joinedUser();

    // Drain the bucket over the socket (one tick, so the checks all land
    // before any meaningful refill)...
    for (let i = 0; i < 12; i++) {
      client.emit('send_message', { roomId, body: `drain ${i}`, clientMessageId: crypto.randomUUID() });
    }
    await client.take('rate_limited', (n: { event: string }) => n.event === 'send_message');

    // ...and the same user's HTTP send is refused: one budget, two transports.
    const res = await supertest(server.url)
      .post(`/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ body: 'over http', clientMessageId: crypto.randomUUID() });
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
