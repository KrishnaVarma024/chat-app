import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { socketAuthMiddleware, type AuthedSocketData } from './socketAuth.middleware';
import { registerRoomHandlers } from './rooms.socket';
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
    logger.info('socket connected', { userId, socketId: socket.id });

    registerRoomHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info('socket disconnected', { userId, socketId: socket.id, reason });
    });
  });

  return io;
}
