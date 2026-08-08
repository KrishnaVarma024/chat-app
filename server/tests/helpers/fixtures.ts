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
  userId: number;
  username: string;
  email: string;
}

/** Registers a brand-new user via the real /auth/register endpoint (not a
 * DB insert shortcut — the whole point of an integration test is that the
 * real hashing/validation/token-issuance path runs) and returns the bits
 * most other tests need. */
export async function registerUser(
  app: Express,
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
    userId: res.body.user.id,
    username: res.body.user.username,
    email: res.body.user.email,
  };
}

/** Creates a room as the given user and returns its id. */
export async function createRoom(app: Express, accessToken: string, name?: string): Promise<number> {
  const res = await supertest(app)
    .post('/rooms')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: name ?? `room_${uniqueSuffix()}` });
  if (res.status !== 201) {
    throw new Error(`createRoom fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id;
}
