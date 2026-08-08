import { createApp } from './app';
import { env } from './config/env';
import { logger } from './observability/logger';

const app = createApp();

app.listen(env.port, () => {
  logger.info('server started', { port: env.port, nodeEnv: env.nodeEnv });
});
