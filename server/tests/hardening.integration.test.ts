import { describe, it, expect } from 'vitest';
import { buildTestApp, supertest } from './helpers/testApp';
import { registerUser, createRoom } from './helpers/fixtures';

/**
 * The automated-suite version of scripts/hardening-test.mjs — same
 * assertions, ported to vitest/supertest so they run as part of `npm test`
 * with no manual server-start step. The .mjs script stays too: it's still
 * the thing to run against a live server on a machine you can watch logs
 * on, and it's what verified this phase for real in the first place (see
 * its own file header). This file is what keeps it from silently
 * regressing later without anyone noticing.
 */
describe('hardening: errors, validation, request ids, rate limits', () => {
  it('malformed JSON body -> 400 MALFORMED_JSON, never a 500', async () => {
    const app = buildTestApp();
    const res = await supertest(app)
      .post('/auth/register')
      .set('Content-Type', 'application/json')
      .send('{ this is not valid json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });

  it('schema-invalid input -> 400 VALIDATION_ERROR', async () => {
    const app = buildTestApp();
    const res = await supertest(app)
      .post('/auth/register')
      .send({ username: 'nopass', email: 'nopass@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('unknown route -> 404 JSON body, not Express default HTML', async () => {
    const app = buildTestApp();
    const res = await supertest(app).get('/this/route/does/not/exist');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('every response carries a unique X-Request-Id', async () => {
    const app = buildTestApp();
    const [a, b] = await Promise.all([supertest(app).get('/health'), supertest(app).get('/health')]);

    expect(a.headers['x-request-id']).toBeTruthy();
    expect(b.headers['x-request-id']).toBeTruthy();
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('rate limit — sending past the send-bucket capacity returns 429 with Retry-After, and recovers', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);

    const send = () =>
      supertest(app)
        .post(`/rooms/${roomId}/messages`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ body: 'spam', clientMessageId: crypto.randomUUID() });

    const results = [];
    for (let i = 0; i < 15; i++) results.push(await send());

    const succeeded = results.filter((r) => r.status === 201);
    const limited = results.filter((r) => r.status === 429);
    expect(succeeded.length).toBeGreaterThan(0);
    expect(limited.length).toBeGreaterThan(0);

    const retryAfter = limited[0].headers['retry-after'];
    expect(retryAfter).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, (Number(retryAfter) + 1) * 1000));
    const afterWaiting = await send();
    expect(afterWaiting.status).toBe(201);
  }, 20_000); // this one genuinely sleeps past Retry-After — needs the longer timeout

  it('rate limit — polling past the poll-bucket capacity returns 429', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);

    const poll = () => supertest(app).get(`/rooms/${roomId}/messages`).set('Authorization', `Bearer ${user.accessToken}`);

    const results = [];
    for (let i = 0; i < 30; i++) results.push(await poll());

    expect(results.some((r) => r.status === 429)).toBe(true);
  });

  it('send and poll have INDEPENDENT budgets — exhausting one does not block the other', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);

    // Exhaust the send bucket (capacity 10) completely.
    for (let i = 0; i < 12; i++) {
      await supertest(app)
        .post(`/rooms/${roomId}/messages`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ body: 'spam', clientMessageId: crypto.randomUUID() });
    }

    // Polling should still work — it's a different bucket entirely.
    const pollRes = await supertest(app)
      .get(`/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(pollRes.status).toBe(200);
  });
});
