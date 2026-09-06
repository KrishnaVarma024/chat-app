import { createServer } from 'http';
import { createApp } from './app';
import { attachSocketServer } from './realtime/socket';
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
attachSocketServer(httpServer);

httpServer.listen(env.port, () => {
  logger.info('server started', { port: env.port, nodeEnv: env.nodeEnv });
});
