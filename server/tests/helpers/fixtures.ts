import type { Express } from 'express';
import { supertest } from './testApp';

let counter = 0;
/** Guarantees uniqueness within a single test run without relying on
 * Date.now() (two calls in the same millisecond, common when tests run
 * fast, would otherwise collide on the username/email unique constraints
 * and fail with an unrelated-looking 409). */
function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now()}_${counter}`;
}

export interface RegisteredUser {
  accessToken: string;
  password: string;
  userId: number;
  username: string;
  email: string;
}

/** `app` is either the Express app (in-process, no port — the v1 style) or a
 * base URL string like `http://127.0.0.1:51234` (Phase 16's real-port harness:
 * supertest accepts both, so the same fixtures serve both styles). */
/** Registers a brand-new user via the real /auth/register endpoint (not a
 * DB insert shortcut — the whole point of an integration test is that the
 * real hashing/validation/token-issuance path runs) and returns the bits
 * most other tests need. */
export async function registerUser(
  app: Express | string,
  overrides: Partial<{ username: string; email: string; password: string }> = {}
): Promise<RegisteredUser> {
  const suffix = uniqueSuffix();
  const body = {
    username: overrides.username ?? `user_${suffix}`.slice(0, 32),
    email: overrides.email ?? `user-${suffix}@example.com`,
    password: overrides.password ?? 'correcthorsebattery',
  };

  const res = await supertest(app).post('/auth/register').send(body);
  if (res.status !== 201) {
    throw new Error(`registerUser fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    accessToken: res.body.accessToken,
    password: body.password,
    userId: res.body.user.id,
    username: res.body.user.username,
    email: res.body.user.email,
  };
}

/** Creates a room as the given user and returns its id. */
export async function createRoom(app: Express | string, accessToken: string, name?: string): Promise<number> {
  const res = await supertest(app)
    .post('/rooms')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: name ?? `room_${uniqueSuffix()}` });
  if (res.status !== 201) {
    throw new Error(`createRoom fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id;
}

/** Joins an existing room as the given user (HTTP membership — the socket
 * layer's join_room checks the same table). */
export async function joinRoomOverHttp(app: Express | string, accessToken: string, roomId: number): Promise<void> {
  const res = await supertest(app).post(`/rooms/${roomId}/join`).set('Authorization', `Bearer ${accessToken}`);
  if (res.status !== 204) {
    throw new Error(`joinRoomOverHttp fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** Logs in over HTTP and returns a FRESH access token (a new JWT with a new
 * `exp`) — what the real client gets from /auth/refresh, minus the cookie
 * dance, which the reauth tests don't need. */
export async function loginForFreshToken(app: Express | string, user: { email: string; password: string }): Promise<string> {
  const res = await supertest(app).post('/auth/login').send({ email: user.email, password: user.password });
  if (res.status !== 200) {
    throw new Error(`loginForFreshToken fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken;
}
