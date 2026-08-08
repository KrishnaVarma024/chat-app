import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { authRouter } from './auth/auth.routes';
import { usersRouter } from './users/users.routes';
import { roomsRouter } from './rooms/rooms.routes';
import { errorHandler, NotFoundError } from './errors';
import { requestId } from './observability/requestId';
import { requestLogger } from './observability/requestLogger';

export function createApp() {
  const app = express();

  // Must be first: every later middleware (including error handling) reads
  // req.id, and the request/response log lines need to bracket everything
  // that happens in between.
  app.use(requestId);
  app.use(requestLogger);

  app.use(express.json());
  // origin must be one exact string (not '*') and credentials must be true,
  // or the browser silently refuses to send/read the httpOnly refresh
  // cookie on cross-origin requests from the Vite dev server.
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  // Only used to read the refresh_token cookie back in /auth/refresh and
  // /auth/logout — no signing secret needed since we're not trusting the
  // cookie's contents directly, only using it as a lookup key into the DB.
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/auth', authRouter);
  app.use('/users', usersRouter);
  app.use('/rooms', roomsRouter);

  // Anything that didn't match a route above — Express's own default 404
  // is an HTML page, which breaks the app's "every error response is
  // { error: { code, message } } JSON" contract for something as ordinary
  // as a typo'd URL or a client hitting a not-yet-implemented endpoint.
  app.use((req, _res, next) => next(new NotFoundError(`No route for ${req.method} ${req.path}`)));

  // Must be registered last — Express identifies error-handling middleware
  // by its four-argument signature and only calls it when next(err) fires.
  app.use(errorHandler);

  return app;
}
