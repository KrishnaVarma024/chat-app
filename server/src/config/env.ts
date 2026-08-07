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
};
