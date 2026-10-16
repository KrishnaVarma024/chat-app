import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, createRoom, loginForFreshToken } from './helpers/fixtures';
import { startRealtimeServer, TestClient, sleep, waitUntil, type RealtimeServer } from './helpers/realtimeHarness';
// The REAL client policy (dependency-free), driving the REAL server.
import { attachConnectionLifecycle } from '../../client/src/realtime/connectionLifecycle';

/**
 * Phase 16 — surviving access-token expiry mid-connection (ARCHITECTURE_V2.md
 * §4). An access token is checked once, at the handshake. Without a
 * mid-connection story, a socket would either outlive its token forever (a
 * revoked or expired session keeps receiving) or be cut off every 15 minutes
 * mid-conversation. The real design: the server warns shortly before expiry,
 * the client refreshes and re-presents a new token ON THE SAME SOCKET, and a
 * client that ignores the warning is disconnected at expiry.
 *
 * Production: 15-minute tokens, warned 60s ahead. Here: ~4-second tokens,
 * warned 1.5s ahead — same code path, compressed clock.
 */
describe('mid-connection reauth over a real port', () => {
  let server: RealtimeServer;
  const clients: TestClient[] = [];
  const detachers: Array<() => void> = [];

  beforeAll(async () => {
    server = await startRealtimeServer({
      env: { ACCESS_TOKEN_TTL: '4s', TOKEN_EXPIRY_WARNING_LEAD_MS: '1500' },
    });
  });
  afterEach(() => {
    while (detachers.length) detachers.pop()!();
    while (clients.length) clients.pop()!.close();
  });
  afterAll(async () => {
    await server.close();
  });

  it('the real client lifecycle refreshes and reauths on the SAME socket: it outlives the original token, and re-arms for the next one', async () => {
    const user = await registerUser(server.url);
    const roomId = await createRoom(server.url, user.accessToken);

    let currentToken = user.accessToken;
    const originalExpiresAt = (JSON.parse(Buffer.from(currentToken.split('.')[1], 'base64url').toString()).exp as number) * 1000;
    const refreshes = vi.fn(async () => {
      currentToken = await loginForFreshToken(server.url, user);
      return true;
    });

    const client = new TestClient(server.url, () => currentToken);
    clients.push(client);
    detachers.push(
      attachConnectionLifecycle(
        client.socket,
        { refreshAccessToken: refreshes, getAccessToken: () => currentToken, flushOutbox: () => undefined },
        { reauthJitterMaxMs: 100 }
      )
    );
    await client.connect();
    await client.join(roomId);

    // The server warns; the lifecycle refreshes and reauths without anyone asking.
    await client.take('token_expiring', undefined, 6000);

    // Sleep PAST the original token's expiry. If reauth did nothing, the
    // server's expiry timer would have disconnected us by now.
    await sleep(Math.max(0, originalExpiresAt - Date.now()) + 600);
    expect(client.socket.connected).toBe(true);
    expect(client.all('disconnect_reason')).toEqual([]);
    expect(refreshes).toHaveBeenCalled();

    // Still fully functional on the same connection.
    const ack = await client.send(roomId, 'still here after my first token died');
    expect(ack.body).toBe('still here after my first token died');

    // And re-armed: the NEW token gets its own warning (and its own reauth).
    await client.take('token_expiring', undefined, 6000);
    await waitUntil(() => refreshes.mock.calls.length >= 2, 4000, 'a second refresh for the second token');
    await sleep(300); // let that second reauth round trip finish
    expect(refreshes.mock.calls.length).toBeLessThanOrEqual(3); // one per warning, never a loop
    expect(client.socket.connected).toBe(true);
    // The connection was never torn down and rebuilt: exactly one connect event, ever.
    expect(client.all('connect').length).toBe(1);
  }, 30_000);

  it('a client that ignores the warning is told why and disconnected at expiry — and cannot come back with that token', async () => {
    const user = await registerUser(server.url);
    const client = new TestClient(server.url, user.accessToken);
    clients.push(client);
    await client.connect();

    // No lifecycle attached: nobody answers token_expiring.
    expect(await client.take('disconnect_reason', undefined, 8000)).toEqual({ reason: 'token_expired' });
    expect(await client.take('disconnect', undefined, 2000)).toBe('io server disconnect');

    // The same (now expired) token is refused at the handshake.
    await expect(new TestClient(server.url, user.accessToken).connect()).rejects.toThrow('UNAUTHORIZED');
  }, 30_000);

  it('a reauth carrying a DIFFERENT user\'s token is refused FORBIDDEN and the socket is dropped — identity cannot change mid-connection', async () => {
    const alice = await registerUser(server.url);
    const mallory = await registerUser(server.url);
    const client = new TestClient(server.url, alice.accessToken);
    clients.push(client);
    await client.connect();

    const result = await client.emitWithAck('reauth', { token: mallory.accessToken });
    expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await client.take('disconnect', undefined, 2000)).toBe('io server disconnect');
  });

  it('a garbage reauth token is refused UNAUTHORIZED but does not kill a socket whose real token is still valid', async () => {
    const user = await registerUser(server.url);
    const client = new TestClient(server.url, user.accessToken);
    clients.push(client);
    await client.connect();

    expect(await client.emitWithAck('reauth', { token: 'not.a.jwt' })).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(await client.emitWithAck('reauth', {})).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(client.socket.connected).toBe(true);
  });
});
