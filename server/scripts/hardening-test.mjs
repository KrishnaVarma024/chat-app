#!/usr/bin/env node
/**
 * Verifies the Phase 7 "definition of done" against a running server:
 *   1. Malformed JSON body -> 400, structured error body, NEVER a 500.
 *   2. Schema-invalid input (missing/wrong-typed fields) -> 400 VALIDATION_ERROR.
 *   3. Unknown route -> 404 with a JSON body, not Express's default HTML page.
 *   4. Every response carries an X-Request-Id header, and two different
 *      requests get two different ids.
 *   5. Sending messages past the rate limiter's burst capacity returns 429
 *      with a Retry-After header; waiting that long and retrying succeeds.
 *   6. Same for the poll endpoint's (separate, higher-capacity) limiter.
 *
 * Requires the API server already running (npm run dev) against a real
 * Postgres (docker compose up -d && npm run migrate:up first) — same
 * convention as concurrency-test.mjs and scrollback-stability-test.mjs.
 *
 * Usage: node scripts/hardening-test.mjs
 */
const BASE_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS — ${label}`);
  } else {
    console.error(`  FAIL — ${label}${detail ? ` (${detail})` : ''}`);
    failures++;
  }
}

async function registerFreshUser() {
  const suffix = Date.now() + Math.random().toString(36).slice(2);
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `hardening${suffix}`.slice(0, 30),
      email: `hardening-${suffix}@example.com`,
      password: 'correcthorsebattery',
    }),
  });
  if (!res.ok) throw new Error(`setup: register failed ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  // 1. Malformed JSON body.
  console.log('1. Malformed JSON body');
  {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not valid json',
    });
    const body = await res.json().catch(() => null);
    check('status is 400, not 500', res.status === 400, `got ${res.status}`);
    check('error code is MALFORMED_JSON', body?.error?.code === 'MALFORMED_JSON', JSON.stringify(body));
  }

  // 2. Schema-invalid input.
  console.log('2. Schema-invalid input (missing password)');
  {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nopass', email: 'nopass@example.com' }),
    });
    const body = await res.json().catch(() => null);
    check('status is 400', res.status === 400, `got ${res.status}`);
    check('error code is VALIDATION_ERROR', body?.error?.code === 'VALIDATION_ERROR', JSON.stringify(body));
  }

  // 3. Unknown route.
  console.log('3. Unknown route');
  {
    const res = await fetch(`${BASE_URL}/this/route/does/not/exist`);
    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.json().catch(() => null);
    check('status is 404', res.status === 404, `got ${res.status}`);
    check('body is JSON, not HTML', contentType.includes('application/json'), contentType);
    check('error code is NOT_FOUND', body?.error?.code === 'NOT_FOUND', JSON.stringify(body));
  }

  // 4. Request id header, unique per request.
  console.log('4. X-Request-Id header');
  {
    const [resA, resB] = await Promise.all([fetch(`${BASE_URL}/health`), fetch(`${BASE_URL}/health`)]);
    const idA = resA.headers.get('x-request-id');
    const idB = resB.headers.get('x-request-id');
    check('request A has an id', Boolean(idA));
    check('request B has an id', Boolean(idB));
    check('the two ids are different', idA !== idB, `${idA} vs ${idB}`);
  }

  // 5. Rate limiting on message send.
  console.log('5. Rate limit — send (capacity 10, refill 2/sec)');
  {
    const user = await registerFreshUser();
    const roomRes = await fetch(`${BASE_URL}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
      body: JSON.stringify({ name: 'hardening-test-room' }),
    });
    const room = await roomRes.json();

    const send = () =>
      fetch(`${BASE_URL}/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
        body: JSON.stringify({ body: 'spam', clientMessageId: crypto.randomUUID() }),
      });

    const statuses = [];
    let retryAfterHeader = null;
    for (let i = 0; i < 15; i++) {
      const res = await send();
      statuses.push(res.status);
      if (res.status === 429 && !retryAfterHeader) retryAfterHeader = res.headers.get('retry-after');
    }
    const successCount = statuses.filter((s) => s === 201).length;
    const rateLimitedCount = statuses.filter((s) => s === 429).length;

    check('first ~10 succeed, later ones 429', successCount > 0 && rateLimitedCount > 0, statuses.join(','));
    check('a 429 included a Retry-After header', Boolean(retryAfterHeader), retryAfterHeader);

    if (retryAfterHeader) {
      const waitMs = (Number(retryAfterHeader) + 1) * 1000;
      console.log(`   waiting ${waitMs}ms (Retry-After) before retrying...`);
      await new Promise((r) => setTimeout(r, waitMs));
      const afterWait = await send();
      check('send succeeds again after waiting Retry-After', afterWait.status === 201, `got ${afterWait.status}`);
    }
  }

  // 6. Rate limiting on poll.
  console.log('6. Rate limit — poll (capacity 20, refill 5/sec)');
  {
    const user = await registerFreshUser();
    const roomRes = await fetch(`${BASE_URL}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
      body: JSON.stringify({ name: 'hardening-test-room-poll' }),
    });
    const room = await roomRes.json();

    const poll = () =>
      fetch(`${BASE_URL}/rooms/${room.id}/messages`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });

    const statuses = [];
    for (let i = 0; i < 30; i++) {
      const res = await poll();
      statuses.push(res.status);
    }
    const rateLimitedCount = statuses.filter((s) => s === 429).length;
    check('polling past capacity eventually returns 429', rateLimitedCount > 0, statuses.join(','));
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
