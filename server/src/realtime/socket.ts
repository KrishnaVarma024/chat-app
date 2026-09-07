import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { socketAuthMiddleware, type AuthedSocketData } from './socketAuth.middleware';
import { registerRoomHandlers } from './rooms.socket';
import { registerMessageHandlers } from './messages.socket';
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
    // server pings every 25s; if a pong doesn't come back within 20s of
    // that ping, this connection is torn down from the server's side
    // regardless of what either OS still thinks about the underlying
    // socket. Phase 13 builds presence on top of this; Phase 9 just wires
    // the timing.
    pingInterval: 25_000,
    pingTimeout: 20_000,
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
    const usernameReady: Promise<string | null> = findUserById(userId).then((user) => {
      if (!user) {
        // The access token was valid (right signature, not expired), but
        // the account behind it is gone — e.g. deleted between token
        // issuance and this connection. Same posture as everywhere else in
        // this app: a token proves who you claimed to be, never that the
        // account still exists.
        logger.warn('socket connection for a user id with no matching row', { userId, socketId: socket.id });
        socket.disconnect(true);
        return null;
      }
      (socket.data as AuthedSocketData).username = user.username;
      return user.username;
    });
    (socket.data as AuthedSocketData).usernameReady = usernameReady;

    logger.info('socket connected', { userId, socketId: socket.id });

    registerRoomHandlers(io, socket);
    registerMessageHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info('socket disconnected', { userId, socketId: socket.id, reason });
    });
  });

  return io;
}
