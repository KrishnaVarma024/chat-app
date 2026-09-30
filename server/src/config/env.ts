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
};
