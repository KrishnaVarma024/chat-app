import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enqueueMessage,
  removeFromQueue,
  isQueued,
  getQueueSnapshot,
  flushQueueOverSocket,
  __resetOutboxForTests,
} from './outbox';
import type { Socket } from 'socket.io-client';

// A minimal stand-in satisfying only the two members flushQueueOverSocket
// actually touches (`connected`, `emit`) — outbox.ts is deliberately typed
// against the real Socket.IO `Socket` type so production code can't drift
// from the real interface, but a test has no reason to construct (or mock)
// an entire real socket connection just to prove queue-draining logic.
function fakeSocket(connected: boolean): Socket & { emitted: unknown[][] } {
  const emitted: unknown[][] = [];
  return {
    connected,
    emit: (...args: unknown[]) => {
      emitted.push(args);
    },
    emitted,
  } as unknown as Socket & { emitted: unknown[][] };
}

beforeEach(() => {
  localStorage.clear();
  __resetOutboxForTests();
});

describe('outbox', () => {
  it('enqueue -> flush over a connected socket emits send_message with the queued fields', () => {
    enqueueMessage(7, 'hello', 'id-1');
    const socket = fakeSocket(true);

    flushQueueOverSocket(socket);

    expect(socket.emitted).toEqual([['send_message', { roomId: 7, body: 'hello', clientMessageId: 'id-1' }]]);
  });

  it('flush is a no-op while disconnected — nothing is emitted, and nothing is dropped from the queue', () => {
    enqueueMessage(7, 'hello', 'id-1');
    const socket = fakeSocket(false);

    flushQueueOverSocket(socket);

    expect(socket.emitted).toEqual([]);
    expect(isQueued('id-1')).toBe(true);
  });

  it('removeFromQueue drops exactly the named message, leaving the rest untouched', () => {
    enqueueMessage(1, 'a', 'id-a');
    enqueueMessage(1, 'b', 'id-b');
    enqueueMessage(1, 'c', 'id-c');

    removeFromQueue('id-b');

    expect(getQueueSnapshot().map((m) => m.clientMessageId)).toEqual(['id-a', 'id-c']);
  });

  it('removeFromQueue for an id that was never queued is a harmless no-op', () => {
    enqueueMessage(1, 'a', 'id-a');
    removeFromQueue('never-queued');
    expect(getQueueSnapshot().map((m) => m.clientMessageId)).toEqual(['id-a']);
  });

  it('flush replays every still-queued message IN ORDER, oldest first', () => {
    enqueueMessage(1, 'first', 'id-1');
    enqueueMessage(1, 'second', 'id-2');
    enqueueMessage(1, 'third', 'id-3');
    const socket = fakeSocket(true);

    flushQueueOverSocket(socket);

    expect(socket.emitted.map((call) => (call[1] as { clientMessageId: string }).clientMessageId)).toEqual([
      'id-1',
      'id-2',
      'id-3',
    ]);
  });

  // This is the exact property the Phase 11 DoD calls out: the queue does
  // not track "already sent, awaiting ack" as a distinct state (see
  // flushQueueOverSocket's own doc comment for why) — it just re-emits
  // everything still present on every call. A message flushed twice
  // before its ack arrives back is a real, expected scenario (a fast
  // reconnect-then-reconnect, or a send racing a connect event), and
  // safety comes from the SERVER's idempotency (Phase 4/10), not from the
  // client refusing to double-emit. This test only proves the CLIENT side
  // of that: flushing twice is not itself an error and does not corrupt
  // the queue or skip/duplicate entries within the queue itself.
  it('flushing twice before removeFromQueue runs re-emits the same message again, harmlessly, on the client side', () => {
    enqueueMessage(1, 'hello', 'id-1');
    const socket = fakeSocket(true);

    flushQueueOverSocket(socket);
    flushQueueOverSocket(socket);

    expect(socket.emitted).toHaveLength(2);
    expect(socket.emitted[0]).toEqual(socket.emitted[1]);
    expect(isQueued('id-1')).toBe(true); // still queued — only an ack/error removes it, not a flush
  });

  it('a message removed after its ack is never replayed by a later flush', () => {
    enqueueMessage(1, 'hello', 'id-1');
    removeFromQueue('id-1'); // simulates message_ack having arrived
    const socket = fakeSocket(true);

    flushQueueOverSocket(socket);

    expect(socket.emitted).toEqual([]);
  });

  it('persists to localStorage on enqueue and survives a fresh module-level reload (page-refresh-while-offline)', async () => {
    enqueueMessage(3, 'still here after reload', 'id-reload');

    // Reset in-memory state WITHOUT touching localStorage, then re-import
    // the module fresh — this is what actually happens on a real page
    // reload: the module's `let queue = ...` re-runs from scratch, reading
    // whatever localStorage already holds.
    vi.resetModules();
    const reloaded = await import('./outbox');

    expect(reloaded.getQueueSnapshot().map((m) => m.clientMessageId)).toEqual(['id-reload']);
  });
});
