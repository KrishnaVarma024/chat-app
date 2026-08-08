import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { TEST_ENV, TEST_DB_PORT } from './testEnv';

const execFileAsync = promisify(execFile);

// Invoking the locally-installed binary directly (node_modules/.bin/...)
// rather than through `npx node-pg-migrate ...` is deliberate, not just a
// style choice — `npx` first checks whether a newer version is available
// before running, which means a network call. In this sandbox that call
// doesn't fail fast, it just hangs, which silently stalled the entire test
// suite indefinitely (caught by watching `npm test` never finish, not by
// a clean error). The local binary is already resolved and installed by
// `npm install`; there's nothing to check.
const nodePgMigrateBin = path.resolve(
  import.meta.dirname,
  '../../node_modules/.bin/node-pg-migrate'
);

/**
 * Runs ONCE, in vitest's main process, before any test file executes.
 * Starts an in-memory Postgres-protocol server (PGlite, exposed over a
 * real TCP socket via pglite-socket) and runs the real migrations against
 * it — so `npm test` needs nothing pre-installed beyond `npm install`.
 * No Docker, no real Postgres, no manual setup step. That's the actual
 * point of Phase 8's "all tests pass in one command."
 *
 * PGlite is architecturally single-connection (this has come up in every
 * phase of this project that touched real concurrency) — see
 * vitest.config.ts's `fileParallelism: false` for how the test suite is
 * shaped around that constraint, and README's "Testing" section for which
 * scenarios this suite deliberately does NOT attempt to prove because of
 * it (those live in scripts/*.mjs, run against a real Postgres instead).
 */
export default async function setup() {
  const db = new PGlite();
  const socketServer = new PGLiteSocketServer({ db, port: TEST_DB_PORT, host: '127.0.0.1' });
  await socketServer.start();

  // MUST be the async execFile, not execFileSync. PGlite is an in-process
  // (WASM) database — pglite-socket doesn't hand connections off to a
  // separate server process, it services them on THIS process's own
  // event loop. execFileSync blocks that event loop synchronously until
  // the child exits; the migration child process's very first act is to
  // open a TCP connection back to this same process's socket server,
  // which can only be accepted by that same event loop — a real
  // deadlock, not just a slow call (confirmed: it hung until
  // execFileSync's own timeout killed it with ETIMEDOUT, every time).
  // The async version yields control back to the event loop while
  // awaiting the child, which is what lets the socket server actually
  // accept and service that connection.
  await execFileAsync(nodePgMigrateBin, ['up'], {
    env: { ...process.env, DATABASE_URL: TEST_ENV.DATABASE_URL },
  });

  // vitest calls the function returned here for teardown, after every test
  // file has finished.
  return async () => {
    await socketServer.stop();
  };
}
