import { vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { io as ioClient, type Socket, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import type { Server as IoServer } from 'socket.io';
import type { QueryResult, QueryResultRow } from 'pg';
import { CatchUpCursor } from '../../../client/src/realtime/catchUpCursor';

/**
 * Phase 16 — ARCHITECTURE_V2.md §13. The real-port realtime harness.
 *
 * supertest (the v1 tool) never binds a port, which is fine for HTTP and
 * useless for WebSockets: the thing under test IS the connection. This
 * harness binds the real Express + Socket.IO stack to an ephemeral port and
 * lets tests drive it with `socket.io-client` as a genuine client — real
 * handshakes, real frames, real disconnects — against the same PGlite
 * database the rest of the suite uses.
 *
 * Why every server is built through `vi.resetModules()` + dynamic import:
 * `src/config/env.ts` reads `process.env` ONCE, at import time, and several
 * modules hold process-wide state (the presence map, the rate-limit bucket
 * stores, the shutdown flag, the pg pool). A test file that wants a 300ms
 * presence grace period, or a 3s access-token TTL, must set those env vars
 * BEFORE the module graph first loads — and must get a pristine graph so
 * state (a spent rate-limit bucket, a flipped shutdown flag) can't leak from
 * one server to the next. A fresh module graph per server is also what lets
 * the shutdown test run an "old instance" and a "new instance" side by side
 * in one process, the way a rolling deploy does.
 */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `predicate` until it is truthy. For asserting on SERVER-side state
 * (e.g. "the socket count dropped to zero") where there is no event to wait on. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(10);
  }
}

/**
 * A promise you resolve from the outside: the "gate" a test parks a handler
 * behind so a race can be forced into one exact interleaving instead of being
 * hoped for with sleeps. Typical use: wrap `server.repo.sendMessage` with
 * `vi.spyOn(...).mockImplementationOnce`, let the real INSERT commit, then
 * `await gate.promise` before returning - the handler is frozen between
 * "committed" and "acked/broadcast" until the test says otherwise.
 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export interface RealtimeServer {
  /** e.g. http://127.0.0.1:51234 — pass to registerUser/createRoom (supertest accepts a URL) and to TestClient. */
  url: string;
  port: number;
  io: IoServer;
  httpServer: HttpServer;
  /** Every server-side socket 'disconnect', with the reason Socket.IO reports. */
  disconnects: Array<{ userId: number; reason: string }>;
  /** Process "exit codes" the shutdown handler requested (it is given a fake exit, never the real one). */
  exitCodes: number[];
  query<R extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  /** Inserts `count` messages straight through the repo (no socket, no rate limiter). Returns their sequence numbers. */
  seedMessages(roomId: number, senderId: number, count: number, prefix?: string): Promise<number[]>;
  /** The real createShutdownHandler wired to THIS server, with a fake exit. */
  triggerShutdown(opts?: { ackTimeoutMs?: number; hardTimeoutMs?: number }): Promise<void>;
  /** The imported repo module, so a test can spy on it (module-instance-matched to THIS server). */
  repo: typeof import('../../src/db/messages.repo');
  /** Likewise the membership check, for tests that need to open a race between "check" and "join". */
  rooms: typeof import('../../src/rooms/rooms.middleware');
  close(): Promise<void>;
}

export interface StartOptions {
  /** Env vars to set BEFORE the app's modules load (see the file header for why). */
  env?: Record<string, string>;
  /** Listen on a specific port (default 0 = ephemeral). Used to stand a "new instance" up where the old one was. */
  port?: number;
}

function applyEnv(overrides: Record<string, string>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function startRealtimeServer(opts: StartOptions = {}): Promise<RealtimeServer> {
  const restoreEnv = applyEnv(opts.env ?? {});
  let mods: {
    app: typeof import('../../src/app');
    socket: typeof import('../../src/realtime/socket');
    pool: typeof import('../../src/db/pool');
    shutdown: typeof import('../../src/lifecycle/shutdown');
    repo: typeof import('../../src/db/messages.repo');
    rooms: typeof import('../../src/rooms/rooms.middleware');
  };
  try {
    vi.resetModules();
    // Sequential, not Promise.all: one deterministic evaluation order.
    const app = await import('../../src/app');
    const socket = await import('../../src/realtime/socket');
    const pool = await import('../../src/db/pool');
    const shutdown = await import('../../src/lifecycle/shutdown');
    const repo = await import('../../src/db/messages.repo');
    const rooms = await import('../../src/rooms/rooms.middleware');
    mods = { app, socket, pool, shutdown, repo, rooms };
  } finally {
    // The graph has captured what it needs; leave process.env as we found it
    // so one file's overrides never bleed into the next.
    restoreEnv();
  }

  const httpServer = createServer(mods.app.createApp());
  const io = mods.socket.attachSocketServer(httpServer);

  const disconnects: RealtimeServer['disconnects'] = [];
  io.on('connection', (s) => {
    s.on('disconnect', (reason) => disconnects.push({ userId: (s.data as { userId: number }).userId, reason }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;

  const exitCodes: number[] = [];
  let closed = false;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    io,
    httpServer,
    disconnects,
    exitCodes,
    repo: mods.repo,
    rooms: mods.rooms,
    query: (sql, params) => mods.pool.pool.query(sql, params as any[]),
    async seedMessages(roomId, senderId, count, prefix = 'seed') {
      const sequences: number[] = [];
      for (let i = 0; i < count; i++) {
        const row = await mods.repo.sendMessage({
          roomId,
          senderId,
          clientMessageId: crypto.randomUUID(),
          body: `${prefix} ${i + 1}`,
        });
        sequences.push(row.sequence_number);
      }
      return sequences;
    },
    triggerShutdown(o = {}) {
      return mods.shutdown.createShutdownHandler({
        io,
        closePool: () => mods.pool.pool.end(),
        exit: (code) => void exitCodes.push(code),
        ackTimeoutMs: o.ackTimeoutMs ?? 1000,
        hardTimeoutMs: o.hardTimeoutMs ?? 5000,
      })('SIGTERM');
    },
    async close() {
      if (closed) return;
      closed = true;
      // Idle keep-alive HTTP sockets (supertest's requests) would otherwise
      // hold httpServer.close() open.
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      // A shutdown test already ended the pool; ending it twice throws.
      await mods.pool.pool.end().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

export interface RecordedEvent {
  event: string;
  payload: any;
  consumed: boolean;
}

interface Waiter {
  names: string[];
  predicate: (payload: any) => boolean;
  resolve: (e: RecordedEvent) => void;
  timer: NodeJS.Timeout;
}

/**
 * A socket.io-client socket that RECORDS everything it receives, so a test
 * can say "wait for X" without caring whether X arrived a microsecond before
 * or after the `await` started. (The classic flaky-realtime-test bug is
 * registering a one-shot listener AFTER the event already fired.)
 *
 * `take` consumes the first matching event — ordered assertions read like
 * the protocol: take ack, then take broadcast. `collect` waits a quiet
 * window and returns whatever matching events arrived, which is how a test
 * asserts a NEGATIVE ("Bob receives nothing") with a bounded wait instead of
 * hoping.
 */
export class TestClient {
  readonly socket: Socket;
  readonly events: RecordedEvent[] = [];
  private waiters: Waiter[] = [];

  constructor(
    url: string,
    token: string | (() => string) | undefined,
    opts: Partial<ManagerOptions & SocketOptions> = {}
  ) {
    this.socket = ioClient(url, {
      // websocket-only by default: the suite proves server behaviour, and
      // skipping the polling->upgrade dance keeps it fast and deterministic.
      // (One test opts back into the default transports to prove the upgrade.)
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth:
        token === undefined
          ? {}
          : typeof token === 'function'
            ? (cb: (data: object) => void) => cb({ token: token() })
            : { token },
      ...opts,
    });
    this.socket.onAny((event: string, ...args: unknown[]) => this.record(event, args[0]));
    this.socket.on('connect', () => this.record('connect', undefined));
    this.socket.on('connect_error', (err: Error) => this.record('connect_error', err));
    this.socket.on('disconnect', (reason: string) => this.record('disconnect', reason));
  }

  private record(event: string, payload: any): void {
    const entry: RecordedEvent = { event, payload, consumed: false };
    this.events.push(entry);
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.names.includes(event) && w.predicate(payload)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        entry.consumed = true;
        w.resolve(entry);
        return;
      }
    }
  }

  /** Resolves with the first not-yet-consumed event named `event` matching `predicate`. */
  async take<T = any>(event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 5000): Promise<T> {
    return (await this.takeAny([event], predicate, timeoutMs)).payload;
  }

  async takeAny(
    names: string[],
    predicate: (payload: any) => boolean = () => true,
    timeoutMs = 5000
  ): Promise<RecordedEvent> {
    const existing = this.events.find((e) => !e.consumed && names.includes(e.event) && predicate(e.payload));
    if (existing) {
      existing.consumed = true;
      return existing;
    }
    return new Promise<RecordedEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        const seen = this.events.map((e) => `${e.event}${e.consumed ? '' : '*'}`).join(', ') || '(nothing)';
        reject(new Error(`timed out after ${timeoutMs}ms waiting for [${names.join('|')}]; events seen (* = unconsumed): ${seen}`));
      }, timeoutMs);
      this.waiters.push({ names, predicate, resolve, timer });
    });
  }

  /** Waits `windowMs`, then consumes and returns every matching event that arrived. */
  async collect<T = any>(event: string, windowMs: number, predicate: (payload: T) => boolean = () => true): Promise<T[]> {
    await sleep(windowMs);
    const out: T[] = [];
    for (const e of this.events) {
      if (!e.consumed && e.event === event && predicate(e.payload)) {
        e.consumed = true;
        out.push(e.payload);
      }
    }
    return out;
  }

  /** Every event of this name ever recorded, consumed or not (for counting). */
  all<T = any>(event: string): T[] {
    return this.events.filter((e) => e.event === event).map((e) => e.payload);
  }

  /** Resolves when connected; rejects with the server's reason if the handshake is refused. */
  async connect(timeoutMs = 5000): Promise<void> {
    const e = await this.takeAny(['connect', 'connect_error'], () => true, timeoutMs);
    if (e.event === 'connect_error') throw new Error((e.payload as Error).message);
  }

  emit(event: string, payload?: unknown): void {
    this.socket.emit(event, payload);
  }

  /** Emits and waits for the server's ack callback (reauth uses one). */
  async emitWithAck<T = any>(event: string, payload: unknown, timeoutMs = 3000): Promise<T> {
    return (await this.socket.timeout(timeoutMs).emitWithAck(event, payload)) as T;
  }

  /** join_room, then resolve once `joined_room` arrives. A catch_up batch (if `sinceSequence` was given) is already recorded by then — the server emits it first. */
  async join(roomId: number, sinceSequence?: number): Promise<void> {
    this.emit('join_room', sinceSequence === undefined ? { roomId } : { roomId, sinceSequence });
    await this.take('joined_room', (p: { roomId: number }) => p.roomId === roomId);
  }

  /** Sends a message and resolves with the server's `message_ack`. */
  async send(roomId: number, body: string, clientMessageId: string = crypto.randomUUID()) {
    this.emit('send_message', { roomId, body, clientMessageId });
    return this.take('message_ack', (m: { client_message_id: string }) => m.client_message_id === clientMessageId);
  }

  close(): void {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    this.socket.close();
  }
}

/**
 * The CLIENT half of the catch-up protocol (ARCHITECTURE_V2.md §7), driving
 * the REAL client cursor logic (client/src/realtime/catchUpCursor.ts — a
 * dependency-free class, imported across packages on purpose) against the
 * REAL server over a real socket. On every (re)connect it rejoins with the
 * cursor; on a `hasMore` page it asks for the next one; live pushes and
 * pages are deduped by sequence number, the way the page's mergeMessages
 * dedupes by client_message_id.
 *
 * Testing the server alone with a hand-written "client" in the test would
 * only prove the server satisfies the test author's idea of the protocol.
 * Using the shipped cursor class is what makes this an end-to-end proof.
 */
export class RoomFollower {
  readonly got = new Map<number, { sequence_number: number; body: string; client_message_id: string }>();
  /** Every arrival, including duplicates, in the order it happened. */
  readonly arrivals: number[] = [];
  readonly cursor: CatchUpCursor;

  constructor(
    readonly client: TestClient,
    readonly roomId: number,
    initialSince: number | null = 0
  ) {
    this.cursor = new CatchUpCursor(initialSince);
    const { socket } = client;
    socket.on('connect', () => socket.emit('join_room', { roomId, sinceSequence: this.cursor.beginJoin() }));
    socket.on('disconnect', () => this.cursor.onDisconnect());
    socket.on('new_message', (m: any) => {
      if (m.room_id !== roomId) return;
      this.apply([m]);
      this.cursor.onLive(m.sequence_number);
    });
    socket.on('catch_up', (batch: any) => {
      if (batch.roomId !== roomId) return;
      this.apply(batch.messages);
      const next = this.cursor.onCatchUp(batch);
      if (next !== null) socket.emit('join_room', { roomId, sinceSequence: next });
    });
  }

  private apply(messages: any[]): void {
    for (const m of messages) {
      this.arrivals.push(m.sequence_number);
      this.got.set(m.sequence_number, m);
    }
  }

  get sequences(): number[] {
    return [...this.got.keys()].sort((a, b) => a - b);
  }
}

// ---------------------------------------------------------------------------
// A TCP proxy: a load balancer you can retarget, silence, or cut
// ---------------------------------------------------------------------------

export interface TestProxy {
  port: number;
  url: string;
  /** New connections go to this port from now on (existing ones are untouched). A rolling deploy shifting traffic to the new instance. */
  setTarget(port: number): void;
  /** From now on, silently drop every byte in both directions. Sockets stay OPEN. */
  blackhole(): void;
  /** Hard-close every proxied connection WITHOUT telling anyone why (no server_shutdown notice) — a crash or a network cut. The listener keeps accepting. */
  cutAll(): void;
  /** Wire bytes that actually crossed the proxy (WebSocket framing included), per direction. For asserting how much a server SAYS, not just what. */
  readonly bytes: { clientToServer: number; serverToClient: number };
  close(): Promise<void>;
}

/**
 * Three things a real network does that an in-process test cannot fake:
 *
 *  - blackhole(): closing a client's socket tells the server immediately
 *    (FIN/RST) and proves nothing about HEARTBEAT detection. The failure
 *    heartbeats exist for is the silent one — a laptop lid closed, a NAT
 *    mapping expiring, a phone in a tunnel: the TCP connection is never
 *    closed, the bytes just stop. Keeping both sockets open while swallowing
 *    the traffic reproduces exactly that.
 *  - setTarget(): clients keep connecting to ONE address (the proxy's) while
 *    the instance behind it changes — which is what a hosting platform's
 *    router does during a deploy.
 *  - cutAll(): the contrast case for graceful shutdown — a connection that
 *    simply vanishes, with no notice.
 */
export async function startProxy(targetPort: number): Promise<TestProxy> {
  let dropping = false;
  let target = targetPort;
  const bytes = { clientToServer: 0, serverToClient: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const pump = (from: net.Socket, to: net.Socket) => {
      from.on('data', (chunk) => {
        if (dropping) return;
        bytes[from === client ? 'clientToServer' : 'serverToClient'] += chunk.length;
        to.write(chunk);
      });
      from.on('close', () => {
        sockets.delete(from);
        to.destroy();
      });
      from.on('error', () => to.destroy());
    };
    pump(client, upstream);
    pump(upstream, client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    bytes,
    setTarget(p) {
      target = p;
    },
    blackhole() {
      dropping = true;
    },
    cutAll() {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
