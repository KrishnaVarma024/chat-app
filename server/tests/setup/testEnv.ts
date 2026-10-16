// Shared between vitest.config.ts (which injects these into every test
// worker's process.env before any test file — or src/config/env.ts, which
// reads process.env — ever runs) and globalSetup.ts (which starts the
// PGlite socket server on the exact port DATABASE_URL points at, and runs
// migrations against that same URL). One source of truth so the two sides
// can't drift out of sync.
//
// Port 5544 is deliberately NOT 5432 (docker-compose's real Postgres) or
// 5433 (used ad-hoc in manual sandbox verification sessions) — so running
// this suite can never collide with a real Postgres or a manually-started
// verification server on your machine.
export const TEST_ENV = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5544/postgres',
  JWT_SECRET: 'integration-test-secret-do-not-use-in-prod-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ACCESS_TOKEN_TTL: '15m',
  CORS_ORIGIN: 'http://localhost:5173',
  NODE_ENV: 'test',
  PORT: '4999',
  // PGlite serves ONE connection at a time; a pool of one makes the pool
  // serialize the overlapping queries a realtime test inherently produces
  // (see the dbPoolMax comment in src/config/env.ts).
  DB_POOL_MAX: '1',
} as const;

export const TEST_DB_PORT = 5544;

// Opt-in parallel test files (`npm run test:fast`). PGlite serves ONE connection at a time, so parallelism
// cannot mean "many files, one database" (that is exactly the "Connection terminated unexpectedly" failure);
// it means one independent database per worker slot, each on its own port, each migrated. The default
// (serial) run uses a single database on TEST_DB_PORT, exactly as before.
export const TEST_PARALLEL = process.env.TEST_PARALLEL === '1';
export const TEST_DB_COUNT = TEST_PARALLEL ? Number(process.env.TEST_DB_COUNT ?? 4) : 1;
/** The database URL for a vitest worker slot (VITEST_POOL_ID is 1-based). */
export const dbUrlForWorker = (poolId: number) =>
  `postgresql://postgres:postgres@127.0.0.1:${TEST_DB_PORT + ((poolId - 1) % TEST_DB_COUNT)}/postgres`;
