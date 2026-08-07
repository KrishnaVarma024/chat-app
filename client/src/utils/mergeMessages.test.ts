import { describe, it, expect } from 'vitest';
import { mergeMessages } from './mergeMessages';
import type { Message, OptimisticMessage } from '../types';

function realMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    room_id: 1,
    sender_id: 1,
    sequence_number: 1,
    client_message_id: 'abc-123',
    body: 'hello',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('mergeMessages', () => {
  it('appends genuinely new messages in sequence order', () => {
    const current = [realMessage({ client_message_id: 'a', sequence_number: 1 })];
    const incoming = [realMessage({ client_message_id: 'b', sequence_number: 2 })];
    const result = mergeMessages(current, incoming);
    expect(result.map((m) => m.client_message_id)).toEqual(['a', 'b']);
  });

  it('reconciles an optimistic placeholder with its confirmed row — exactly once, not twice', () => {
    const optimistic: OptimisticMessage = {
      id: null,
      room_id: 1,
      sender_id: 1,
      sequence_number: null,
      client_message_id: 'same-key',
      body: 'hi',
      created_at: '2026-01-01T00:00:00.000Z',
      status: 'pending',
    };
    const confirmed = realMessage({ client_message_id: 'same-key', sequence_number: 5, id: 99 });

    const result = mergeMessages([optimistic], [confirmed]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(confirmed);
    expect('status' in result[0]).toBe(false); // the pending placeholder is fully gone, not just hidden
  });

  it('is idempotent when the same message arrives twice via different paths (send response + a later poll)', () => {
    const msg = realMessage({ client_message_id: 'dup', sequence_number: 3 });
    const afterFirstArrival = mergeMessages([], [msg]);
    const afterSecondArrival = mergeMessages(afterFirstArrival, [msg]);

    expect(afterSecondArrival).toHaveLength(1);
    expect(afterSecondArrival[0]).toEqual(msg);
  });

  it('keeps optimistic (unconfirmed) entries sorted after every confirmed message', () => {
    const confirmed = realMessage({ client_message_id: 'confirmed', sequence_number: 10 });
    const optimistic: OptimisticMessage = {
      id: null,
      room_id: 1,
      sender_id: 1,
      sequence_number: null,
      client_message_id: 'not-yet-confirmed',
      body: 'typing...',
      created_at: '2026-01-01T00:00:01.000Z',
      status: 'pending',
    };
    const result = mergeMessages([optimistic, confirmed], []);
    expect(result.map((m) => m.client_message_id)).toEqual(['confirmed', 'not-yet-confirmed']);
  });

  // Phase 6 exercise B2 — mergeMessages assumes nothing about the ORDER the
  // `incoming` array arrives in. The server always sends ascending-sorted
  // pages (messages.repo.ts's ORDER BY), so this can't happen for real
  // today — but this test asks "what if it ever did" and proves the
  // answer with the code, not a guess: mergeMessages re-sorts the WHOLE
  // merged Map.values() on every call (see the `merged.sort(...)` line),
  // so it never trusts the incoming array's order at all. A backend
  // regression that shipped pages out of order would still render
  // correctly on the client — this function doesn't have a "seam" that
  // out-of-order input could break.
  it('B2 — still renders correctly-ordered output even if `incoming` arrives shuffled, not ascending', () => {
    const current = [realMessage({ client_message_id: 'a', sequence_number: 1 })];
    // Deliberately out of order: seq 5 before seq 3 before seq 4.
    const shuffledIncoming = [
      realMessage({ client_message_id: 'e', sequence_number: 5 }),
      realMessage({ client_message_id: 'c', sequence_number: 3 }),
      realMessage({ client_message_id: 'd', sequence_number: 4 }),
    ];

    const result = mergeMessages(current, shuffledIncoming);

    expect(result.map((m) => m.sequence_number)).toEqual([1, 3, 4, 5]);
    expect(result.map((m) => m.client_message_id)).toEqual(['a', 'c', 'd', 'e']);
  });
});
