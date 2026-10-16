import { createServer } from 'http';
import { createApp } from './app';
import { attachSocketServer } from './realtime/socket';
import { createShutdownHandler } from './lifecycle/shutdown';
import { pool } from './db/pool';
import { env } from './config/env';
import { logger } from './observability/logger';

const app = createApp();

// Express alone only knows how to handle plain HTTP request/response.
// Socket.IO needs the underlying http.Server itself — it intercepts the
// 'upgrade' event Node fires when a client asks to switch a connection
// from HTTP to the WebSocket protocol, something Express's request
// handler never sees. Wrapping app in an explicit http.Server (instead of
// the implicit one app.listen() creates internally) is what lets both
// Express routes and Socket.IO share the exact same port.
const httpServer = createServer(app);
const io = attachSocketServer(httpServer);

httpServer.listen(env.port, () => {
  logger.info('server started', { port: env.port, nodeEnv: env.nodeEnv });
});

// Phase 15 — ARCHITECTURE_V2.md §14. Render (and every orchestrator) sends
// SIGTERM before replacing an instance; every deploy is exactly this. SIGINT
// is the same story for Ctrl-C in local dev. Without a handler, Node's
// default is to die on the spot — every socket just vanishes mid-frame.
const shutdown = createShutdownHandler({
  io,
  closePool: () => pool.end(),
  exit: (code) => process.exit(code),
  ackTimeoutMs: env.shutdownAckTimeoutMs,
  hardTimeoutMs: env.shutdownHardTimeoutMs,
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
