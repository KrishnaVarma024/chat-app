import type { Server } from 'socket.io';
import { logger } from '../observability/logger';
import { suspendPresence } from '../realtime/presence';
import { isShuttingDown, markShuttingDown } from './shutdownState';

export interface ShutdownDeps {
  io: Server;
  /** Releases the database pool. Injected (rather than imported) so this
   * module is testable without a real Postgres and has no opinion about
   * which pool it is. */
  closePool: () => Promise<void>;
  /** process.exit, injected for tests. */
  exit: (code: number) => void;
  /** Max time to wait for clients to acknowledge `server_shutdown`. */
  ackTimeoutMs: number;
  /** Absolute ceiling for the whole sequence. */
  hardTimeoutMs: number;
}

/**
 * Resolves once every connected client has acknowledged the notice — or
 * `timeoutMs` has passed, whichever comes first. Never rejects: a client
 * that doesn't answer is a fact to log, not a reason to abort shutdown.
 *
 * Uses a broadcast WITH acknowledgement (`io.timeout(ms).emit(ev, cb)`,
 * Socket.IO >= 4.5) rather than "emit, then sleep a bit and hope it
 * flushed." The old shape either wastes time when everyone answered in
 * 5ms, or closes too early when the network is slow; waiting for the actual
 * acks is both faster in the common case and correct in the slow one.
 * With zero clients connected the callback fires immediately.
 */
export function broadcastShutdownNotice(io: Server, timeoutMs: number): Promise<{ acked: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    io.timeout(timeoutMs).emit('server_shutdown', (err: Error | null, responses: unknown[]) => {
      resolve({ acked: responses?.length ?? 0, timedOut: Boolean(err) });
    });
  });
}

/**
 * Builds the SIGTERM/SIGINT handler — ARCHITECTURE_V2.md §14.
 *
 * Order matters, and each step exists because of what breaks if it is
 * missing or moved:
 *
 *   1. Flag + suspend presence — so /health starts returning 503 (an
 *      orchestrator should stop routing here) and the disconnect wave in
 *      step 3 doesn't broadcast a storm of 'offline' events from a process
 *      that is mid-teardown.
 *   2. Tell every client `server_shutdown` and wait for acks. This is the
 *      whole point: a client that merely sees its TCP connection die has
 *      to assume a failure and pays its first backoff delay before
 *      retrying. A client that was TOLD can reconnect immediately — on a
 *      rolling deploy the next instance is already up.
 *   3. io.close() — stops accepting new connections, closes existing ones,
 *      and closes the underlying HTTP server (letting in-flight HTTP
 *      requests finish first; Node closes idle keep-alive sockets itself).
 *   4. pool.end() — only AFTER step 3, because closing connections can
 *      still trigger handlers that touch the database.
 *   5. Exit 0.
 *
 * A hard timer runs from the first line: if any step hangs, the process
 * exits non-zero on its own schedule instead of waiting for the platform's
 * SIGKILL to choose the moment (which would skip step 4 entirely and leave
 * Postgres to time out the orphaned connections).
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  return async function shutdown(signal: string): Promise<void> {
    // Idempotent: a platform that sends SIGTERM twice, or a developer
    // mashing Ctrl-C, must not run teardown twice.
    if (isShuttingDown()) return;
    markShuttingDown();
    logger.info('shutdown initiated', { signal });

    const hardTimer = setTimeout(() => {
      logger.error('shutdown exceeded hard timeout — forcing exit', { hardTimeoutMs: deps.hardTimeoutMs });
      deps.exit(1);
    }, deps.hardTimeoutMs);
    // Doesn't keep the event loop alive on its own: if everything finishes
    // early the process should be free to exit without waiting this out.
    hardTimer.unref();

    try {
      suspendPresence();

      const { acked, timedOut } = await broadcastShutdownNotice(deps.io, deps.ackTimeoutMs);
      logger.info('server_shutdown broadcast complete', { acked, timedOut });

      await new Promise<void>((resolve) => deps.io.close(() => resolve()));
      logger.info('socket server and http listener closed');

      await deps.closePool();
      logger.info('database pool closed');

      clearTimeout(hardTimer);
      deps.exit(0);
    } catch (err) {
      logger.error('error during shutdown', { error: err instanceof Error ? err.message : String(err) });
      clearTimeout(hardTimer);
      deps.exit(1);
    }
  };
}
