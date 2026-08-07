import type { DisplayMessage, Message } from '../types';

/**
 * The one merge function every insertion point (initial load, poll,
 * scrollback, and reconciling our own optimistic send) funnels through.
 * Keying on client_message_id — not array position or sequence_number — is
 * what makes "exactly once" actually true: whichever path resolves a given
 * message first (the direct POST /messages response, or a later poll tick
 * picking up the same row) wins, and the other path's arrival just
 * overwrites the same map entry instead of appending a second one. An
 * optimistic placeholder and its eventual server-confirmed row share the
 * same client_message_id by construction, so this is also exactly how a
 * "pending" bubble turns into a confirmed one with zero special-casing.
 */
export function mergeMessages(current: DisplayMessage[], incoming: Message[]): DisplayMessage[] {
  const byClientId = new Map<string, DisplayMessage>(current.map((m) => [m.client_message_id, m]));
  for (const msg of incoming) {
    byClientId.set(msg.client_message_id, msg);
  }
  const merged = Array.from(byClientId.values());
  // Optimistic entries (sequence_number === null) have no ordering signal
  // from the server yet — they always sort after every confirmed message,
  // which is correct since they represent "the thing I just typed."
  merged.sort((a, b) => (a.sequence_number ?? Infinity) - (b.sequence_number ?? Infinity));
  return merged;
}
