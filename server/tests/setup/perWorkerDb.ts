import { dbUrlForWorker } from './testEnv';

/**
 * Runs in every test worker BEFORE the test file (and therefore before
 * src/config/env.ts, which reads process.env at import time) loads. Points the
 * worker at its own database. With one database (the default) this resolves to
 * the same URL vitest.config.ts already injects, so it is a no-op.
 */
process.env.DATABASE_URL = dbUrlForWorker(Number(process.env.VITEST_POOL_ID ?? 1));
