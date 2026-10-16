import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: required('JWT_SECRET'),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  // The Vite dev server runs on its own origin (e.g. http://localhost:5173),
  // so every request from it to this API is cross-origin. Because the
  // refresh flow depends on an httpOnly cookie, the browser will only
  // attach it (and only expose the response) to a CORS request that
  // explicitly opts in with credentials — a wildcard '*' origin is
  // rejected by browsers the moment credentials are involved, so this has
  // to be one exact, named origin, not a default-allow-everything.
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',

  // Upper bound on simultaneous Postgres connections from this process.
  // 10 is the production default (comfortably under a small managed
  // Postgres's connection cap even with a couple of instances during a
  // rolling deploy). Overridable for one reason: the test suite's database
  // (PGlite — see tests/setup/globalSetup.ts) is a single-connection
  // engine, and a realtime test inherently runs several queries at once (a
  // connection's username lookup, its presence lookup, the client's first
  // join_room). Pinning the test pool to ONE connection makes the pool
  // itself serialize those queries — exactly what the database underneath
  // would force anyway — instead of failing with "Connection terminated
  // unexpectedly". Production never sets this.
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),

  // Socket.IO's app-level heartbeat (ARCHITECTURE_V2.md §8). Overridable
  // via env, not hardcoded, for exactly one reason: verifying "a dead
  // connection is detected via heartbeat timeout, not left hanging" for
  // real means actually waiting out a timeout — at the 25s/20s production
  // values that's a genuinely slow test. Production always gets the
  // documented defaults; only a test run that explicitly sets these env
  // vars sees different numbers.
  socketPingIntervalMs: Number(process.env.SOCKET_PING_INTERVAL_MS ?? 25_000),
  socketPingTimeoutMs: Number(process.env.SOCKET_PING_TIMEOUT_MS ?? 20_000),

  // How long presence waits after a user's last socket disconnects before
  // broadcasting them offline (ARCHITECTURE_V2.md §9) — long enough that an
  // ordinary page refresh's disconnect-then-immediate-reconnect never
  // produces a flicker, short enough that a genuine departure is reflected
  // promptly. Same override reasoning as the ping settings above: a test
  // proving "reconnect within the grace window broadcasts nothing" needs a
  // short window to run quickly, not the production value.
  presenceGracePeriodMs: Number(process.env.PRESENCE_GRACE_PERIOD_MS ?? 7_000),

  // How long BEFORE an access token's `exp` the server tells a socket to
  // reauthenticate (`token_expiring` — ARCHITECTURE_V2.md §4). Long enough
  // for a refresh round trip plus retries to finish comfortably; reauth.socket.ts
  // additionally never lets the warning land earlier than the midpoint of a
  // token's remaining life, so a short-lived token can't put a client into a
  // refresh loop. Overridable for the same reason as the heartbeat settings:
  // proving "survives expiry mid-connection" for real means actually waiting
  // out an expiry, and nobody wants a 15-minute test.
  tokenExpiryWarningLeadMs: Number(process.env.TOKEN_EXPIRY_WARNING_LEAD_MS ?? 60_000),

  // Graceful shutdown (ARCHITECTURE_V2.md §14). On SIGTERM the server tells
  // every client `server_shutdown`, then waits for them to acknowledge it —
  // but never longer than this, so one unresponsive client can't hold a
  // deploy hostage. Deterministic ("everyone has heard, or 3s passed")
  // instead of a guessed sleep.
  shutdownAckTimeoutMs: Number(process.env.SHUTDOWN_ACK_TIMEOUT_MS ?? 3_000),
  // Absolute ceiling on the whole shutdown sequence, after which the process
  // exits non-zero regardless of what is still open. Must stay comfortably
  // under the platform's own SIGKILL deadline (Render's default is 30s), or
  // the platform picks the moment of death instead of this process.
  shutdownHardTimeoutMs: Number(process.env.SHUTDOWN_HARD_TIMEOUT_MS ?? 10_000),
};
