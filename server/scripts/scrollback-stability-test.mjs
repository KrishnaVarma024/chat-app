#!/usr/bin/env node
/**
 * Hard exercise 2 (Phase 5) — proves cursor pagination is stable under
 * REAL concurrent writes, not just the sequential before/after snapshot
 * used during initial Phase 5 verification. Requires the API server
 * already running (npm run dev) against a real Postgres (docker compose
 * up -d && npm run migrate:up first) — this needs genuinely simultaneous
 * database connections, which the sandbox's PGlite test harness can't
 * host at all (same single-connection ceiling as concurrency-test.mjs).
 *
 * Two things happen at the same time:
 *  - READERS: N concurrent, IDENTICAL scrollback requests, all anchored
 *    at the same fixed cursor.
 *  - WRITERS: M concurrent new message sends into the same room, landing
 *    somewhere in the middle of the readers' in-flight requests.
 *
 * Claim under test: every reader gets back a byte-identical page,
 * regardless of how many writes land mid-flight — because
 * WHERE sequence_number < $cursor compares against a fixed value, not
 * against "however the table happens to look right now."
 *
 * Usage: node scripts/scrollback-stability-test.mjs [readerCount] [writerCount]
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const READER_COUNT = Number(process.argv[2] ?? 20);
const WRITER_COUNT = Number(process.argv[3] ?? 20);
const SEED_COUNT = 20; // enough existing history to scroll back into

function encodeCursor(seq) {
  return Buffer.from(JSON.stringify({ seq })).toString('base64url');
}

async function main() {
  const suffix = Date.now();

  const registerRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `scrolltest${suffix}`,
      email: `scrolltest-${suffix}@example.com`,
      password: 'correcthorsebattery',
    }),
  });
  if (!registerRes.ok) {
    throw new Error(`register failed: ${registerRes.status} ${await registerRes.text()}`);
  }
  const { accessToken } = await registerRes.json();
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };

  const roomRes = await fetch(`${BASE_URL}/rooms`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: `scrolltest-${suffix}` }),
  });
  if (!roomRes.ok) {
    throw new Error(`create room failed: ${roomRes.status} ${await roomRes.text()}`);
  }
  const room = await roomRes.json();

  console.log(`Seeding ${SEED_COUNT} messages into room ${room.id}...`);
  for (let i = 1; i <= SEED_COUNT; i++) {
    const res = await fetch(`${BASE_URL}/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ body: `seed ${i}`, clientMessageId: randomUUID() }),
    });
    if (!res.ok) {
      throw new Error(`seed send failed: ${res.status} ${await res.text()}`);
    }
  }

  // Anchor a scrollback cursor in the middle of the seeded history.
  // before=cursor(15) with limit=5 should always return messages 10-14,
  // no matter what gets written afterward — new messages always get
  // sequence numbers ABOVE 20, strictly after this anchor point.
  const anchorCursor = encodeCursor(15);
  const expectedSeqs = JSON.stringify([10, 11, 12, 13, 14]);

  console.log(`Firing ${READER_COUNT} concurrent identical scrollback reads (before=cursor(15), limit=5)`);
  console.log(`...while firing ${WRITER_COUNT} concurrent new message sends into the same room.`);

  const readers = Array.from({ length: READER_COUNT }, () =>
    fetch(`${BASE_URL}/rooms/${room.id}/messages?before=${anchorCursor}&limit=5`, {
      headers: authHeaders,
    }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : await r.text() }))
  );

  const writers = Array.from({ length: WRITER_COUNT }, (_, i) =>
    fetch(`${BASE_URL}/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ body: `concurrent write ${i}`, clientMessageId: randomUUID() }),
    }).then((r) => r.status)
  );

  const [readerResults, writerStatuses] = await Promise.all([
    Promise.all(readers),
    Promise.all(writers),
  ]);

  const writerFailures = writerStatuses.filter((s) => s !== 201);
  console.log(`Writers: ${WRITER_COUNT - writerFailures.length}/${WRITER_COUNT} succeeded.`);
  if (writerFailures.length > 0) {
    console.error(`FAIL: ${writerFailures.length} concurrent writes did not return 201:`, writerFailures);
    process.exitCode = 1;
    return;
  }

  const readerFailures = readerResults.filter((r) => r.status !== 200);
  console.log(`Readers: ${READER_COUNT - readerFailures.length}/${READER_COUNT} returned 200.`);
  if (readerFailures.length > 0) {
    console.error(`FAIL: ${readerFailures.length} concurrent reads did not return 200:`, readerFailures.slice(0, 3));
    process.exitCode = 1;
    return;
  }

  const allSeqs = readerResults.map((r) => JSON.stringify(r.body.messages.map((m) => m.sequence_number)));
  const allIdentical = allSeqs.every((s) => s === expectedSeqs);

  console.log(`Expected every reader to see: ${expectedSeqs}`);
  console.log(`All ${READER_COUNT} readers returned exactly that, despite ${WRITER_COUNT} concurrent writes: ${allIdentical}`);

  if (!allIdentical) {
    const distinct = [...new Set(allSeqs)];
    console.error('FAIL — readers disagreed with each other and/or with the expected page:', distinct);
    process.exitCode = 1;
    return;
  }

  console.log('PASS');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
