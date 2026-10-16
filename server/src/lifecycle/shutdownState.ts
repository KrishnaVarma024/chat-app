/**
 * A single process-wide boolean, in its own tiny module on purpose: the
 * Express app (for /health) and the shutdown orchestrator both need it, and
 * if it lived next to the orchestrator, importing "am I shutting down?"
 * would drag the entire socket/DB import graph into app.ts.
 */
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** One-way: once a process has begun shutting down it never un-begins. */
export function markShuttingDown(): void {
  shuttingDown = true;
}
