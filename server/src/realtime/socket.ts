import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { socketAuthMiddleware, type AuthedSocketData } from './socketAuth.middleware';
import { registerRoomHandlers } from './rooms.socket';
import { registerMessageHandlers } from './messages.socket';
import { markOnline, markOffline } from './presence';
import { findUserById } from '../db/users.repo';
import { logger } from '../observability/logger';

/**
 * Mounts Socket.IO on the SAME http.Server instance Express is already
 * listening on — one process, one port, no second listener to deploy or
 * point a load balancer at. See ARCHITECTURE_V2.md §2.
 */
export function attachSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.corsOrigin, credentials: true },
    // App-level heartbeat (ARCHITECTURE_V2.md §8) — not a guess based on
    // whatever the OS/TCP stack on either end eventually notices. The
    // server pings every 25s (production default — see env.ts); if a pong
    // doesn't come back within 20s of that ping, this connection is torn
    // down from the server's side regardless of what either OS still
    // thinks about the underlying socket. Read from env (not hardcoded) so
    // a verification script can prove real heartbeat-timeout detection
    // without waiting out the full production timing — see env.ts's
    // socketPingIntervalMs/socketPingTimeoutMs doc comment.
    pingInterval: env.socketPingIntervalMs,
    pingTimeout: env.socketPingTimeoutMs,
  });

  // Runs BEFORE 'connection' fires — an unauthenticated handshake never
  // reaches the handler below at all.
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    const { userId } = socket.data as AuthedSocketData;

    // Started here, NOT awaited here. Handlers below are registered
    // synchronously, in the same tick 'connection' fired — exactly like
    // Phase 9. Socket.IO does not buffer an incoming event against a
    // listener that doesn't exist yet, so if this connection handler
    // awaited the lookup BEFORE calling registerRoomHandlers/
    // registerMessageHandlers, a client that emits immediately after
    // connecting could have that very first event silently dropped (this
    // was caught for real: the Phase 10 verification script hung waiting
    // on an ack that never came, because the first send_message arrived
    // before `await findUserById` had returned and the handler existed).
    // Instead, every handler that needs the username awaits this SAME
    // promise — the first awaiter pays for the real lookup, everyone after
    // it (in practice: every message after a socket's literal first) gets
    // an already-resolved promise for free.
    const usernameReady: Promise<string | null> = findUserById(userId)
      .then((user) => {
        if (!user) {
          // The access token was valid (right signature, not expired), but
          // the account behind it is gone — e.g. deleted between token
          // issuance and this connection. Same posture as everywhere else
          // in this app: a token proves who you claimed to be, never that
          // the account still exists.
          logger.warn('socket connection for a user id with no matching row', { userId, socketId: socket.id });
          socket.disconnect(true);
          return null;
        }
        (socket.data as AuthedSocketData).username = user.username;
        return user.username;
      })
      .catch((err) => {
        // Found for real during Phase 11 verification, not theoretical:
        // a socket that connects and disconnects again WITHOUT ever
        // sending a message (this script's "kill it before the ack can
        // arrive" case) means nothing ever awaits `usernameReady` before
        // it settles. If `findUserById` itself rejects — a transient DB
        // hiccup, demonstrated here by PGlite's single-connection ceiling
        // under concurrent load, but just as possible as a real Postgres
        // blip in production — a promise with a `.then()` but no
        // `.catch()` that nothing ever awaits becomes an UNHANDLED
        // rejection. Node's default behavior for those is to crash the
        // entire process — not just this one socket, every connected
        // user's connection, over one flaky lookup for a single cosmetic
        // display name. This handler exists specifically so this promise
        // can never reject, only ever resolve (to null on failure) —
        // structurally ruling out that crash regardless of timing.
        //
        // Deliberately does NOT disconnect the socket here, unlike the
        // "no such user" branch above: that case is a real authorization
        // concern (the account doesn't exist); this one is an
        // infrastructure hiccup on a lookup whose only consumer is
        // `sender_username` on a broadcast (messages.socket.ts) — cosmetic
        // for everyone else in the room, not a reason to drop an
        // otherwise validly-authenticated user.
        logger.error('username lookup failed for a connected socket', {
          userId,
          socketId: socket.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    (socket.data as AuthedSocketData).usernameReady = usernameReady;

    logger.info('socket connected', { userId, socketId: socket.id });

    registerRoomHandlers(io, socket);
    registerMessageHandlers(io, socket);

    // Fire-and-forget, same posture as usernameReady above: presence is a
    // best-effort broadcast, not something any caller here needs to await
    // before proceeding. Chained onto usernameReady (which itself never
    // rejects — see its own .catch above) rather than fired independently
    // in the same tick: these are two unrelated DB reads on a connection
    // that's typically otherwise idle at this exact instant, so there's no
    // reason to make them race each other for a connection-pool slot when
    // sequencing costs a fraction of a millisecond and reduces DB
    // contention right at the moment a lot of connections might be landing
    // at once (a server restart's reconnect storm, for one). markOnline's
    // own internals still never reject on their own (its one await is a
    // SELECT with no user-facing failure mode worth blocking a connection
    // over), but the .catch is cheap insurance against the exact class of
    // bug Phase 11 found the hard way — an unawaited promise with no
    // rejection handler can crash the whole process.
    usernameReady.then(() => markOnline(io, userId, socket.id)).catch((err) => {
      logger.error('failed to mark socket online for presence', {
        userId,
        socketId: socket.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Deliberately no branching on `reason` — ARCHITECTURE_V2.md §8: a
    // heartbeat-timeout death and an explicit close run through the exact
    // same cleanup. markOffline itself doesn't even look at why it's being
    // called, only at how many sockets this user has left.
    socket.on('disconnect', (reason) => {
      logger.info('socket disconnected', { userId, socketId: socket.id, reason });
      markOffline(io, userId, socket.id);
    });
  });

  return io;
}
