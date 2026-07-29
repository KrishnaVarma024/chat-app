import { Pool } from 'pg';
import { env } from '../config/env';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

// A pooled connection can die between checkouts (network blip, DB restart).
// Without this handler an "idle client error" crashes the whole process —
// log it and let the pool recycle the connection instead.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});
