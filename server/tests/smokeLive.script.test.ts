import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { startRealtimeServer, type RealtimeServer } from './helpers/realtimeHarness';

/**
 * scripts/smoke-live.mjs is what you run against the DEPLOYED server to
 * verify real-time behaviour through the hosting platform's proxy — which
 * means it only ever runs against production, by hand, rarely. Code like that
 * rots silently: the next protocol change breaks it and nobody notices until
 * the day it is needed. So it also runs here, against a local server, on
 * every `npm test`. If an event is renamed or a flow changes, this fails in
 * CI instead of during a deploy.
 *
 * (It is the one realtime test that cannot catch a PROXY problem — there is
 * no proxy — and that is the point of running the real thing in production.)
 */
describe('scripts/smoke-live.mjs', () => {
  let server: RealtimeServer;

  beforeAll(async () => {
    server = await startRealtimeServer({ env: { PRESENCE_GRACE_PERIOD_MS: '500' } });
  });
  afterAll(async () => {
    await server.close();
  });

  it('passes every check against a local server', async () => {
    // Async execFile, NOT execFileSync: PGlite and this server live on THIS
    // process's event loop — blocking it would deadlock the child's requests.
    const script = path.resolve(import.meta.dirname, '../scripts/smoke-live.mjs');
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile('node', [script, server.url], { timeout: 55_000 }, (err, out, errOut) => {
        resolve({ stdout: `${out}\n${errOut}`, code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) || 1 : 0 });
      });
    });

    console.log(stdout); // shown by vitest only when the test fails (silent: 'passed-only')
    expect(stdout).not.toMatch(/FAIL/);
    expect(stdout).toContain('ALL SMOKE CHECKS PASSED');
    expect(code).toBe(0);
  }, 60_000);
});
