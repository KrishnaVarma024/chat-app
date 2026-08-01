#!/usr/bin/env node
/**
 * Fires N concurrent message sends into a fresh room and verifies the
 * resulting sequence numbers are contiguous, 1..N, with zero gaps and
 * zero duplicates — the core correctness claim behind the atomic counter
 * in messages.repo.ts. This is the actual test the Phase 4 "definition of
 * done" describes; run it against a real Postgres, not the sandbox's
 * PGlite-based test harness (PGlite is architecturally single-connection
 * and cannot exercise real concurrent access at all).
 *
 * Also verifies idempotency: resending an already-used client_message_id
 * returns the original message instead of creating a duplicate.
 *
 * Requires the API server already running (npm run dev) against a real
 * Postgres (docker compose up -d && npm run migrate:up first).
 *
 * Usage: node scripts/concurrency-test.mjs [count]
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Same fix as src/db/pool.ts, applied here too: this script opens its own
// separate pg.Client in a separate Node process, so pool.ts's type-parser
// registration (process-wide, but only within the *server's* process) never
// reaches it. Without this, BIGINT columns (sequence_number) come back as
// strings ("1", "2"...) instead of numbers, and the contiguity check below
// would fail on a type mismatch even when the actual data is correct.
pg.types.setTypeParser(20, (value) => parseInt(value, 10));

const BASE_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const COUNT = Number(process.argv[2] ?? 50);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Set DATABASE_URL (the same one the server is using) before running this.');
  process.exit(1);
}

async function main() {
  const suffix = Date.now();

  const registerRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `loadtest${suffix}`,
      email: `concurrency-test-${suffix}@example.com`,
      password: 'correcthorsebattery',
    }),
  });
  if (!registerRes.ok) {
    throw new Error(`register failed: ${registerRes.status} ${await registerRes.text()}`);
  }
  const { accessToken } = await registerRes.json();

  const roomRes = await fetch(`${BASE_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: `concurrency-test-${suffix}` }),
  });
  if (!roomRes.ok) {
    throw new Error(`create room failed: ${roomRes.status} ${await roomRes.text()}`);
  }
  const room = await roomRes.json();

  const clientMessageIds = Array.from({ length: COUNT }, () => randomUUID());

  console.log(`Firing ${COUNT} concurrent sends into room ${room.id}...`);
  const start = Date.now();

  const statuses = await Promise.all(
    clientMessageIds.map((clientMessageId, i) =>
      fetch(`${BASE_URL}/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ body: `msg ${i}`, clientMessageId }),
      }).then((r) => r.status)
    )
  );

  const elapsed = Date.now() - start;
  const failures = statuses.filter((status) => status !== 201);
  console.log(`Done in ${elapsed}ms — ${COUNT - failures.length}/${COUNT} requests returned 201.`);
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} requests did not return 201:`, failures);
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const { rows } = await client.query(
    'SELECT sequence_number, client_message_id FROM messages WHERE room_id = $1 ORDER BY sequence_number',
    [room.id]
  );

  const seqs = rows.map((r) => r.sequence_number);
  const expected = Array.from({ length: COUNT }, (_, i) => i + 1);
  const isContiguous = JSON.stringify(seqs) === JSON.stringify(expected);

  console.log(`Message rows in DB: ${seqs.length} (expected ${COUNT})`);
  console.log(`Sequence numbers contiguous 1..${COUNT}, zero gaps, zero duplicates: ${isContiguous}`);

  if (!isContiguous || seqs.length !== COUNT) {
    console.error('FAIL — sequence numbers are not exactly 1..N with no gaps or duplicates.');
    await client.end();
    process.exitCode = 1;
    return;
  }

  // Idempotency: resend one of the client_message_ids that already
  // succeeded above, and confirm it comes back as the SAME row, not a
  // new one — and that the total row count doesn't grow.
  const retryTarget = rows[0];
  const retryRes = await fetch(`${BASE_URL}/rooms/${room.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ body: 'THIS SHOULD BE IGNORED', clientMessageId: retryTarget.client_message_id }),
  });
  const retryBody = await retryRes.json();

  const { rows: countRows } = await client.query('SELECT count(*) FROM messages WHERE room_id = $1', [room.id]);
  await client.end();

  const sameSequence = retryBody.sequence_number === retryTarget.sequence_number;
  const rowCountUnchanged = Number(countRows[0].count) === COUNT;

  console.log(`Idempotent retry returned original sequence_number (${retryTarget.sequence_number}): ${sameSequence}`);
  console.log(`Total message rows still ${COUNT} after retry (no duplicate created): ${rowCountUnchanged}`);

  if (!sameSequence || !rowCountUnchanged) {
    console.error('FAIL — idempotent retry did not behave correctly.');
    process.exitCode = 1;
    return;
  }

  console.log('PASS');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
