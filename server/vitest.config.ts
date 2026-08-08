import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './tests/setup/testEnv';

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
    // PGlite backs this whole suite with a single connection (see
    // globalSetup.ts) — running test FILES in parallel would mean multiple
    // files' queries genuinely racing over that one connection, which
    // reliably produces "Connection terminated unexpectedly" (the same
    // PGlite ceiling hit in nearly every earlier phase of this project).
    // Forcing serial file execution isn't a workaround for a flaky test —
    // it's the correct shape for the actual constraint: this suite proves
    // correctness, not throughput, and doesn't need real parallelism to
    // do that.
    fileParallelism: false,
    // The app's own request logger (observability/logger.ts) writes one
    // JSON line per request — genuinely useful when reading a FAILED
    // test's output (see it in context), pure noise for a passing one.
    // 'passed-only' keeps console output attached to failures and hides
    // it for anything that passed, instead of an all-or-nothing choice.
    silent: 'passed-only',
  },
});
