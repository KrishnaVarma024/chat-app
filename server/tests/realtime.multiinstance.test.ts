import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { registerUser } from './helpers/fixtures';
import { startRealtimeServer, TestClient, sleep, waitUntil } from './helpers/realtimeHarness';

/**
 * Phase 16 exercise T1 - why two instances without sticky routing break the
 * upgrade, shown rather than asserted from memory.
 *
 * Engine.IO keeps each session (the `sid`) in the memory of the instance that
 * answered the first handshake. A long-polling session is several HTTP
 * requests, and the polling -> WebSocket upgrade is another one, all carrying
 * that sid. Round-robin them across two instances and the second request lands
 * on an instance that has never heard of the sid: HTTP 400
 * {"code":1,"message":"Session ID unknown"}.
 *
 * Two real server instances (separate module graphs, separate Engine.IO
 * session tables) sit behind a tiny HTTP proxy that is either round-robin
 * (broken) or pinned (what sticky sessions do for one client). A free Render
 * web service is a single instance, so the load balancer has nothing to choose
 * between - which is why this class of bug is invisible there and appears the
 * day a second instance is added.
 */

type Pick = (requestNumber: number) => number; // -> upstream port

async function httpProxy(pick: Pick, log: string[]) {
  let n = 0;
  const server = http.createServer((req, res) => {
    const port = pick(n++);
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      const chunks: Buffer[] = [];
      const failed = (r.statusCode ?? 200) >= 400;
      if (failed) r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        if (failed) log.push(`${req.method} -> instance :${port} -> ${r.statusCode} ${Buffer.concat(chunks).toString()}`);
      });
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  // The WebSocket upgrade is a raw TCP hand-off; forward it to whichever instance `pick` chooses.
  server.on('upgrade', (req, socket, head) => {
    const port = pick(n++);
    const up = net.connect(port, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

describe('two server instances behind a load balancer', () => {
  const clients: TestClient[] = [];
  afterEach(() => {
    while (clients.length) clients.pop()!.close();
  });

  it('round-robin (no stickiness): the handshake succeeds on one instance, the next request hits the other -> "Session ID unknown"', async () => {
    const A = await startRealtimeServer();
    const B = await startRealtimeServer();
    const seenByServers: string[] = [];
    for (const s of [A, B]) {
      s.io.engine.on('connection_error', (err: { code: number; message: string }) => seenByServers.push(`${err.code}:${err.message}`));
    }
    const user = await registerUser(A.url); // same JWT secret in both graphs, so the token is valid on either
    const seenByProxy: string[] = [];
    const lb = await httpProxy((n) => (n % 2 === 0 ? A.port : B.port), seenByProxy);
    try {
      const c = new TestClient(lb.url, user.accessToken, { transports: ['polling', 'websocket'] });
      clients.push(c);
      const outcome = await c.takeAny(['connect', 'connect_error'], () => true, 8000);
      await sleep(300);

      expect(outcome.event).toBe('connect_error');
      expect(seenByProxy.some((l) => l.includes('"Session ID unknown"') && l.includes('400'))).toBe(true);
      expect(seenByServers).toContain('1:Session ID unknown'); // Engine.IO error code 1
    } finally {
      await lb.close();
      await A.close();
      await B.close();
    }
  }, 30_000);

  it('sticky routing (every request of a client to one instance): connects, upgrades to WebSocket, no errors', async () => {
    const A = await startRealtimeServer();
    const B = await startRealtimeServer();
    const user = await registerUser(A.url);
    const seenByProxy: string[] = [];
    const lb = await httpProxy(() => A.port, seenByProxy); // a real LB hashes the client IP or a cookie; same effect for one client
    try {
      const c = new TestClient(lb.url, user.accessToken, { transports: ['polling', 'websocket'] });
      clients.push(c);
      await c.connect();
      await waitUntil(() => c.socket.io.engine.transport.name === 'websocket', 5000, 'upgrade to websocket');
      expect(seenByProxy).toEqual([]);
      // An upgraded socket is detached from http.Server; release it before the proxy tries to close.
      c.close();
      await sleep(100);
    } finally {
      await lb.close();
      await A.close();
      await B.close();
    }
  }, 30_000);
});
