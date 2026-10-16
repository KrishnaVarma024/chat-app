import { defineConfig } from 'vitest/config';
import { TEST_ENV, TEST_PARALLEL, TEST_DB_COUNT } from './tests/setup/testEnv';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/setup/globalSetup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Applied to every test worker's process.env BEFORE any test file (and
    // therefore before src/config/env.ts, which reads process.env at
    // import time) runs.
    env: TEST_ENV,
    // PGlite backs this suite with ONE connection per database (see
    // globalSetup.ts) — running test FILES in parallel against one database
    // would mean multiple files' queries genuinely racing over that single
    // connection, which reliably produces "Connection terminated
    // unexpectedly". So the default is serial files on one database: it isn't
    // a workaround for a flaky test, it's the correct shape for the actual
    // constraint (this suite proves correctness, not throughput).
    //
    // `npm run test:fast` (TEST_PARALLEL=1) opts into parallel files by giving
    // each worker slot its OWN database instead (globalSetup starts
    // TEST_DB_COUNT of them; tests/setup/perWorkerDb.ts points each worker at
    // its slot). Measured on 4 cores: ~65s wall serial -> ~31s. See
    // ARCHITECTURE_V2.md §13 for what that costs.
    fileParallelism: TEST_PARALLEL,
    maxWorkers: TEST_DB_COUNT,
    setupFiles: ['./tests/setup/perWorkerDb.ts'],
    // The app's own request logger (observability/logger.ts) writes one
    // JSON line per request — genuinely useful when reading a FAILED
    // test's output (see it in context), pure noise for a passing one.
    // 'passed-only' keeps console output attached to failures and hides
    // it for anything that passed, instead of an all-or-nothing choice.
    silent: 'passed-only',
  },
});
