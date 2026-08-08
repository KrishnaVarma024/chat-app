import { describe, it, expect } from 'vitest';
import { buildTestApp, supertest, extractCookieValue } from './helpers/testApp';
import { registerUser } from './helpers/fixtures';

describe('auth', () => {
  it('register -> returns a user + access token, and a refresh cookie is set', async () => {
    const app = buildTestApp();
    const res = await supertest(app).post('/auth/register').send({
      username: 'newuser1',
      email: 'newuser1@example.com',
      password: 'correcthorsebattery',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('newuser1');
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.headers['set-cookie']?.some((c: string) => c.startsWith('refresh_token='))).toBe(true);
  });

  it('register with an already-used email -> 409 CONFLICT, not a raw DB error', async () => {
    const app = buildTestApp();
    await registerUser(app, { email: 'dupe@example.com' });
    const res = await supertest(app).post('/auth/register').send({
      username: 'someoneelse',
      email: 'dupe@example.com',
      password: 'correcthorsebattery',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('login with wrong password -> 401, same message shape as "no such user"', async () => {
    const app = buildTestApp();
    await registerUser(app, { email: 'loginme@example.com', password: 'correcthorsebattery' });

    const wrongPassword = await supertest(app)
      .post('/auth/login')
      .send({ email: 'loginme@example.com', password: 'totallywrong' });
    const noSuchUser = await supertest(app)
      .post('/auth/login')
      .send({ email: 'nobody-registered-this@example.com', password: 'whatever123' });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // Phase 1's whole point: an attacker probing this endpoint can't tell
    // "wrong password" apart from "no such account" from the response body.
    expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
  });

  it('a protected route rejects a missing/garbage token but accepts a real one', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);

    const noToken = await supertest(app).get('/rooms');
    const garbageToken = await supertest(app).get('/rooms').set('Authorization', 'Bearer not-a-real-token');
    const realToken = await supertest(app).get('/rooms').set('Authorization', `Bearer ${user.accessToken}`);

    expect(noToken.status).toBe(401);
    expect(garbageToken.status).toBe(401);
    expect(realToken.status).toBe(200);
  });

  it('refresh rotates the token and the new access token works', async () => {
    const app = buildTestApp();
    const agent = supertest.agent(app); // persists the refresh cookie across calls

    const registerRes = await agent.post('/auth/register').send({
      username: 'rotator',
      email: 'rotator@example.com',
      password: 'correcthorsebattery',
    });
    expect(registerRes.status).toBe(201);
    const originalRefreshToken = extractCookieValue(registerRes.headers['set-cookie'], 'refresh_token');

    const refreshRes = await agent.post('/auth/refresh');
    expect(refreshRes.status).toBe(200);
    expect(typeof refreshRes.body.accessToken).toBe('string');

    // Proof that rotation actually happened: the REFRESH token (a random
    // UUID per src/db/refresh-tokens.repo.ts) is guaranteed unique on every
    // issuance, so comparing it is a real assertion. The ACCESS token
    // (tokens.ts) is a JWT signed over { sub, iat, exp } with no random
    // component — jsonwebtoken sets `iat` at 1-second granularity, so two
    // tokens for the same user issued within the same wall-clock second
    // are genuinely, deterministically byte-identical (same header +
    // payload + HMAC signature in, same string out). A first draft of this
    // test asserted the access token itself changed, which is exactly the
    // kind of thing that's true "in practice" during slow manual testing
    // but false here, where register-then-refresh can easily land in the
    // same second — caught by the test actually failing, not by reasoning
    // about it in the abstract. Not a bug in the app: an access token
    // doesn't need to be unique per issuance, only valid until it expires,
    // which the request below proves directly instead of inferring it
    // from string inequality.
    const newRefreshToken = extractCookieValue(refreshRes.headers['set-cookie'], 'refresh_token');
    expect(newRefreshToken).not.toBe(originalRefreshToken);

    const meCheck = await agent.get('/rooms').set('Authorization', `Bearer ${refreshRes.body.accessToken}`);
    expect(meCheck.status).toBe(200);
  });

  // This is one of Phase 8's three named "load-bearing scenarios" —
  // reuse detection. It's sequential (do A, then B, assert), not a race,
  // so it's fully provable here without needing real Postgres concurrency.
  it('reuse detection: replaying an already-rotated refresh token revokes the WHOLE family', async () => {
    const app = buildTestApp();
    const agent = supertest.agent(app);

    const registerRes = await agent.post('/auth/register').send({
      username: 'reusevictim',
      email: 'reusevictim@example.com',
      password: 'correcthorsebattery',
    });
    const originalRefreshToken = extractCookieValue(registerRes.headers['set-cookie'], 'refresh_token');

    // Legitimate rotation — agent's cookie jar now holds a NEW refresh
    // token; originalRefreshToken is now stale from the server's point of
    // view.
    const legitimateRefresh = await agent.post('/auth/refresh');
    expect(legitimateRefresh.status).toBe(200);

    // An attacker (or a bug) replaying the OLD, already-rotated token.
    const replay = await supertest(app)
      .post('/auth/refresh')
      .set('Cookie', `refresh_token=${originalRefreshToken}`);
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toMatch(/reuse detected/i);

    // The real proof: the LEGITIMATE agent's own next refresh attempt,
    // using the token it rotated to fair and square, ALSO now fails —
    // because reuse of any token in a family revokes the entire family,
    // not just the replayed token. A weaker implementation would only
    // reject the specific stolen token and let the legitimate session
    // continue, which teaches you nothing about whether the thief also
    // has the newer token.
    const agentTriesAgain = await agent.post('/auth/refresh');
    expect(agentTriesAgain.status).toBe(401);
  });

  it('logout clears the session — a subsequent refresh fails', async () => {
    const app = buildTestApp();
    const agent = supertest.agent(app);
    await agent.post('/auth/register').send({
      username: 'logsout',
      email: 'logsout@example.com',
      password: 'correcthorsebattery',
    });

    const logoutRes = await agent.post('/auth/logout');
    expect(logoutRes.status).toBe(204);

    const refreshAfterLogout = await agent.post('/auth/refresh');
    expect(refreshAfterLogout.status).toBe(401);
  });
});
