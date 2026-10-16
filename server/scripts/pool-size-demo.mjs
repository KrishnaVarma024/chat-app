#!/usr/bin/env node
/**
 * What a connection pool of ONE hides - and what it shouts about. Phase 16
 * exercise T2.
 *
 * The test suite pins DB_POOL_MAX=1 (PGlite serves one connection at a time),
 * and production runs 10. A pool of one runs every transaction to completion
 * before the next starts, so anything that needs TWO connections cannot occur
 * in the tests. This script runs the same patterns against a real Postgres
 * with pools of different sizes, so the difference is a measurement, not a
 * claim.
 *
 *   E1  read-modify-write race on the sequence counter   -> pool=1 HIDES it
 *   E2  holding a client while awaiting a second query    -> pool=1 EXPOSES it
 *       (and pool=10 hides it until ten are in flight)
 *   E3  two transactions locking two rows in opposite order -> pool=1 HIDES it
 *   E5  the duplicate-retry path COMMIT (burns a sequence number) vs ROLLBACK
 *
 * Needs a real Postgres with the migrations applied, e.g.:
 *   docker compose up -d && npm run migrate:up && node scripts/pool-size-demo.mjs
 * It creates its own user and rooms (random suffix) and leaves a few rows
 * behind; run it against a dev database, not production.
 *
 * Usage: node scripts/pool-size-demo.mjs
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

pg.types.setTypeParser(20, (value) => parseInt(value, 10)); // BIGINT -> number, like src/db/pool.ts

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL (a real Postgres with migrations applied) before running this.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: e }));
const withTimeout = (p, ms) => Promise.race([settle(p), sleep(ms).then(() => ({ timeout: true }))]);

const admin = new pg.Client({ connectionString: DATABASE_URL });
await admin.connect();
const suffix = randomUUID().slice(0, 8);
const {
  rows: [{ id: userId }],
} = await admin.query(`INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`demo_${suffix}`, `demo_${suffix}@example.invalid`]);

async function newRoom() {
  const {
    rows: [{ id }],
  } = await admin.query(`INSERT INTO rooms (name, created_by) VALUES ('pool-size-demo', $1) RETURNING id`, [userId]);
  await admin.query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, userId]);
  return id;
}

const checks = [];
function expect(label, condition) {
  checks.push({ label, condition });
  console.log(`   ${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

// ---- E1 -----------------------------------------------------------------------------------------
// The real implementation (messages.repo.ts): one atomic upsert takes the counter row's lock.
async function sendCorrect(pool, roomId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const {
      rows: [{ last_sequence }],
    } = await c.query(
      `INSERT INTO room_sequence_counters (room_id, last_sequence) VALUES ($1, 1)
       ON CONFLICT (room_id) DO UPDATE SET last_sequence = room_sequence_counters.last_sequence + 1
       RETURNING last_sequence`,
      [roomId]
    );
    await c.query(`INSERT INTO messages (room_id, sender_id, sequence_number, client_message_id, body) VALUES ($1, $2, $3, $4, 'x')`, [roomId, userId, last_sequence, randomUUID()]);
    await c.query('COMMIT');
    return last_sequence;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
// The tempting "simplification": read the counter, add one, write it back. No lock between read and write.
async function sendNaive(pool, roomId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('SELECT last_sequence FROM room_sequence_counters WHERE room_id = $1', [roomId]);
    const next = (r.rows[0]?.last_sequence ?? 0) + 1;
    await c.query(`INSERT INTO room_sequence_counters (room_id, last_sequence) VALUES ($1, $2) ON CONFLICT (room_id) DO UPDATE SET last_sequence = $2`, [roomId, next]);
    await c.query(`INSERT INTO messages (room_id, sender_id, sequence_number, client_message_id, body) VALUES ($1, $2, $3, $4, 'x')`, [roomId, userId, next, randomUUID()]);
    await c.query('COMMIT');
    return next;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
async function e1(send, max) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max });
  const roomId = await newRoom();
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => send(pool, roomId)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value).sort((a, b) => a - b);
  const codes = [...new Set(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code))];
  await pool.end();
  return { succeeded: ok.length, contiguous: ok.length === 50 && ok.every((v, i) => v === i + 1), codes };
}
console.log('\nE1  50 concurrent sends: read-modify-write vs the atomic upsert');
const naive1 = await e1(sendNaive, 1);
const naive10 = await e1(sendNaive, 10);
const good1 = await e1(sendCorrect, 1);
const good10 = await e1(sendCorrect, 10);
console.log(`   naive   pool=1 : ${naive1.succeeded}/50 ok, contiguous=${naive1.contiguous}`);
console.log(`   naive   pool=10: ${naive10.succeeded}/50 ok, contiguous=${naive10.contiguous}, errors=${naive10.codes.join(',') || '-'}`);
console.log(`   correct pool=1 : ${good1.succeeded}/50 ok, contiguous=${good1.contiguous}`);
console.log(`   correct pool=10: ${good10.succeeded}/50 ok, contiguous=${good10.contiguous}`);
expect('the naive version PASSES with a pool of one (the tests would be green)', naive1.contiguous);
expect('the naive version FAILS with a pool of ten (23505 unique_violation)', !naive10.contiguous && naive10.codes.includes('23505'));
expect('the real implementation is correct at either pool size', good1.contiguous && good10.contiguous);

// ---- E2 -----------------------------------------------------------------------------------------
async function sendNested(pool, roomId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // "just reuse checkRoomMembership": it uses pool.query, i.e. a SECOND connection while this one is held.
    await pool.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
async function e2(max, concurrency) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max });
  const roomId = await newRoom();
  const results = await Promise.all(Array.from({ length: concurrency }, () => withTimeout(sendNested(pool, roomId), 2000)));
  return { finished: results.filter((r) => r.ok).length, concurrency, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } };
  // (a deadlocked pool is deliberately left open; the process exits at the end)
}
console.log('\nE2  a transaction that awaits a second pool.query while holding its client');
const n1 = await e2(1, 1);
const n9 = await e2(10, 9);
const n10 = await e2(10, 10);
console.log(`   pool=1  x1 : ${n1.finished}/1 finished   pool state ${JSON.stringify(n1.pool)}`);
console.log(`   pool=10 x9 : ${n9.finished}/9 finished`);
console.log(`   pool=10 x10: ${n10.finished}/10 finished  pool state ${JSON.stringify(n10.pool)}`);
expect('a pool of ONE deadlocks on the very first request (loud: the test suite would hang at once)', n1.finished === 0);
expect('a pool of TEN survives nine concurrent requests...', n9.finished === 9);
expect('...and deadlocks completely at ten: every client held by a caller waiting for another', n10.finished === 0 && n10.pool.waiting === 10);

// ---- E3 -----------------------------------------------------------------------------------------
async function lockTwo(pool, first, second) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE room_sequence_counters SET last_sequence = last_sequence + 1 WHERE room_id = $1', [first]);
    await sleep(150);
    await c.query('UPDATE room_sequence_counters SET last_sequence = last_sequence + 1 WHERE room_id = $1', [second]);
    await c.query('COMMIT');
    return 'committed';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
async function e3(max) {
  const A = await newRoom();
  const B = await newRoom();
  await admin.query('INSERT INTO room_sequence_counters (room_id, last_sequence) VALUES ($1, 0), ($2, 0)', [A, B]);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max });
  const r = await Promise.allSettled([lockTwo(pool, A, B), lockTwo(pool, B, A)]);
  await pool.end();
  return r.map((x) => (x.status === 'fulfilled' ? x.value : x.reason.code));
}
console.log('\nE3  two transactions locking two rows in opposite order');
const d1 = await e3(1);
const d2 = await e3(2);
console.log(`   pool=1: ${d1.join(' | ')}`);
console.log(`   pool=2: ${d2.join(' | ')}`);
expect('with a pool of one both commit - the deadlock cannot form', d1.every((x) => x === 'committed'));
expect('with two connections Postgres kills one with 40P01 deadlock_detected', d2.includes('40P01'));

// ---- E5 -----------------------------------------------------------------------------------------
async function sendDup(pool, roomId, clientMessageId, onDuplicate) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const {
      rows: [{ last_sequence }],
    } = await c.query(
      `INSERT INTO room_sequence_counters (room_id, last_sequence) VALUES ($1, 1)
       ON CONFLICT (room_id) DO UPDATE SET last_sequence = room_sequence_counters.last_sequence + 1 RETURNING last_sequence`,
      [roomId]
    );
    const ins = await c.query(
      `INSERT INTO messages (room_id, sender_id, sequence_number, client_message_id, body) VALUES ($1, $2, $3, $4, 'x')
       ON CONFLICT (room_id, sender_id, client_message_id) DO NOTHING RETURNING sequence_number`,
      [roomId, userId, last_sequence, clientMessageId]
    );
    if (ins.rows.length === 0) {
      await c.query(onDuplicate); // 'COMMIT' (today: the claimed number is burned) or 'ROLLBACK' (the counter bump is undone)
      return;
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
async function e5(onDuplicate) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const roomId = await newRoom();
  const ids = Array.from({ length: 30 }, () => randomUUID());
  const calls = [...ids, ...ids.slice(0, 20), ...ids.slice(0, 10)].sort(() => Math.random() - 0.5); // 30 distinct, 30 duplicate retries, all in flight at once
  await Promise.all(calls.map((id) => sendDup(pool, roomId, id, onDuplicate)));
  const { rows } = await admin.query('SELECT sequence_number FROM messages WHERE room_id = $1 ORDER BY sequence_number', [roomId]);
  await pool.end();
  const seqs = rows.map((r) => r.sequence_number);
  let holes = 0;
  for (let i = 1; i < seqs.length; i++) holes += seqs[i] - seqs[i - 1] - 1;
  return { messages: seqs.length, max: seqs[seqs.length - 1], holes };
}
console.log('\nE5  30 messages, each also retried (30 duplicates in flight): what the duplicate path does with its claimed number');
const commit = await e5('COMMIT');
const rollback = await e5('ROLLBACK');
console.log(`   duplicate path COMMIT  (today)      : ${commit.messages} messages, highest sequence ${commit.max}, ${commit.holes} holes`);
console.log(`   duplicate path ROLLBACK (alternative): ${rollback.messages} messages, highest sequence ${rollback.max}, ${rollback.holes} holes`);
expect('COMMIT on the duplicate path burns numbers (holes in the sequence)', commit.holes > 0);
expect('ROLLBACK on the duplicate path leaves the sequence gap-free', rollback.holes === 0 && rollback.max === 30);

await admin.end();
const failed = checks.filter((c) => !c.condition);
console.log(failed.length === 0 ? '\nALL DEMONSTRATIONS HELD' : `\n${failed.length} DEMONSTRATION(S) DID NOT HOLD`);
process.exit(failed.length === 0 ? 0 : 1);
