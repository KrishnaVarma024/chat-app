/**
 * Real integration test against a LIVE backend (npm run dev in server/,
 * pointed at a real Postgres). This is not mocked in any way — it imports
 * the actual shipped api/* modules (the same code ChatRoomPage calls) and
 * drives them over real HTTP, exactly like two separate browser tabs
 * would.
 *
 * "Two separate browser tabs" is the interesting part to get right: each
 * tab has its OWN module state (tokenStore.ts's in-memory access token is
 * a module-level singleton, same as it would be in a real browser JS
 * heap). Reusing one import across "alice" and "bob" would let bob's
 * login silently clobber alice's token. `vi.resetModules()` + a fresh
 * dynamic import gives each simulated session a genuinely separate copy
 * of every api module, including its own private tokenStore — which is
 * the same isolation two real browser tabs get for free.
 *
 * Run: npm run test:integration (server must already be running)
 */
import { describe, it, expect, beforeAll } from 'vitest';

interface Session {
  auth: typeof import('../api/auth');
  rooms: typeof import('../api/rooms');
  messages: typeof import('../api/messages');
  cursor: typeof import('../api/cursor');
}

async function newSession(): Promise<Session> {
  const [auth, rooms, messages, cursor] = await Promise.all([
    import('../api/auth'),
    import('../api/rooms'),
    import('../api/messages'),
    import('../api/cursor'),
  ]);
  return { auth, rooms, messages, cursor };
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

beforeAll(async () => {
  const res = await fetch(`${API_BASE}/health`).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(
      `Backend not reachable at ${API_BASE}/health — start it first (npm run dev in server/) before running the integration suite.`
    );
  }
});

describe('two-session message sync (real backend, real client modules)', () => {
  it('bob sees alice\'s message within a single poll interval, with her real username attached', async () => {
    const suffix = Date.now();

    const { vi } = await import('vitest');
    const alice = await newSession();
    vi.resetModules();
    const bob = await newSession();
    vi.resetModules();

    await alice.auth.register(`alice${suffix}`, `alice-${suffix}@example.com`, 'correcthorsebattery');
    await bob.auth.register(`bob${suffix}`, `bob-${suffix}@example.com`, 'correcthorsebattery');

    const room = await alice.rooms.createRoom(`Sync test room ${suffix}`);
    await bob.rooms.joinRoom(room.id);

    const clientMessageId = crypto.randomUUID();
    const sent = await alice.messages.sendMessage(room.id, 'hello bob, one poll interval please', clientMessageId);
    expect(sent.body).toBe('hello bob, one poll interval please');

    // Bob starts from "the beginning" (seq 0), exactly like ChatRoomPage
    // seeds pollCursor from latest_sequence_number on initial load.
    const BASE_POLL_INTERVAL_MS = 2000; // must match ChatRoomPage's constant
    await new Promise((resolve) => setTimeout(resolve, BASE_POLL_INTERVAL_MS));

    const page = await bob.messages.pollMessages(room.id, bob.cursor.encodeCursor(0));

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].client_message_id).toBe(clientMessageId);
    expect(page.messages[0].body).toBe('hello bob, one poll interval please');
    // Proves the sender_username JOIN added for Phase 6 actually works —
    // bob can render "who sent this" without any separate lookup.
    expect(page.messages[0].sender_username).toBe(`alice${suffix}`);
  }, 15000);

  it('a retried send with the same client_message_id (the "came back online" case) lands exactly once', async () => {
    const suffix = Date.now();
    const { vi } = await import('vitest');
    const alice = await newSession();
    vi.resetModules();

    await alice.auth.register(`alice2-${suffix}`, `alice2-${suffix}@example.com`, 'correcthorsebattery');
    const room = await alice.rooms.createRoom(`Idempotent send room ${suffix}`);

    const clientMessageId = crypto.randomUUID();
    // First attempt — imagine this is the one that went out right before
    // the network dropped, so the client never actually saw the response
    // and marked it "failed" in the UI.
    const firstAttempt = await alice.messages.sendMessage(room.id, 'are you still there?', clientMessageId);
    // "Reconnected" — client retries with the SAME client-generated id,
    // exactly what a real retry-after-failure would do.
    const secondAttempt = await alice.messages.sendMessage(room.id, 'are you still there?', clientMessageId);

    // Same underlying row both times — the server's ON CONFLICT DO NOTHING
    // + fetch-the-existing-row path (messages.repo.ts) is what makes this
    // true, not any client-side dedup.
    expect(secondAttempt.id).toBe(firstAttempt.id);
    expect(secondAttempt.sequence_number).toBe(firstAttempt.sequence_number);

    const page = await alice.messages.pollMessages(room.id, alice.cursor.encodeCursor(0));
    const matching = page.messages.filter((m) => m.client_message_id === clientMessageId);
    expect(matching).toHaveLength(1); // exactly once, not twice
  }, 15000);
});
