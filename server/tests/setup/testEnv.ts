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
} as const;

export const TEST_DB_PORT = 5544;
