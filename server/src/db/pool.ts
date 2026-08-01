import { Pool, types } from 'pg';
import { env } from '../config/env';

// Postgres OID 20 = int8 (BIGINT/BIGSERIAL). node-postgres returns these as
// strings by default, because a BIGINT can exceed Number.MAX_SAFE_INTEGER
// and silently lose precision as a JS number — but every id in this schema
// (users, rooms, messages, sequence numbers) is a BIGSERIAL, and this app
// is nowhere near the ~9 quadrillion-row scale where that would matter.
// Every repo interface in this codebase already declares ids as `number`
// (see UserRow, RoomRow, etc.) — without this, those types were quietly
// lying about what came back at runtime. This is process-wide (pg.types is
// a shared registry, not per-Pool), which is what we want: every BIGINT
// column, everywhere, consistently.
types.setTypeParser(20, (value: string) => parseInt(value, 10));

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
