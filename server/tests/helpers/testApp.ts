import { createApp } from '../../src/app';

/**
 * supertest wraps the Express app directly (via Node's http module) and
 * never actually binds a listening TCP port for the app itself — only the
 * app's real request/response pipeline runs, exactly as it would in
 * production, just without the network hop. This is why these are still
 * genuine integration tests and not mocks: every middleware, every zod
 * schema, every SQL query against the real (PGlite-backed) database runs
 * for real. The only thing not real is the socket between client and
 * server, which was never the thing under test.
 */
export function buildTestApp() {
  return createApp();
}

/**
 * supertest.agent(app) — not plain supertest(app) — persists cookies
 * across requests made through the SAME agent instance, the same way a
 * real browser tab keeps its cookie jar across requests to the same
 * origin. Needed for anything touching the refresh-token flow, since that
 * lives entirely in an httpOnly cookie.
 */
export { default as supertest } from 'supertest';

/** Pulls a named cookie's raw value out of a supertest response's
 * Set-Cookie header(s) — used when a test needs to manually replay an
 * OLD cookie value after an agent has already moved past it (e.g. reuse
 * detection), which `agent()`'s automatic jar can't do since it always
 * holds the latest value. */
export function extractCookieValue(setCookieHeader: string[] | undefined, name: string): string {
  const line = setCookieHeader?.find((c) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`Cookie "${name}" not found in Set-Cookie header(s): ${JSON.stringify(setCookieHeader)}`);
  const value = line.split(';')[0].slice(name.length + 1);
  return value;
}
