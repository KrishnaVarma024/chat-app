import express from 'express';
import { authRouter } from './auth/auth.routes';
import { usersRouter } from './users/users.routes';
import { errorHandler } from './errors';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/auth', authRouter);
  app.use('/users', usersRouter);

  // Must be registered last — Express identifies error-handling middleware
  // by its four-argument signature and only calls it when next(err) fires.
  app.use(errorHandler);

  return app;
}
