// Mirrors the API's response shapes (see server/src/*/*.routes.ts). Kept as
// plain interfaces, not classes — this is wire data, not behavior.

export interface User {
  id: number;
  username: string;
  email: string;
}

export interface Room {
  id: number;
  name: string;
  created_by: number;
  created_at: string;
}

export interface Message {
  id: number;
  room_id: number;
  sender_id: number;
  // Only present on messages that came back from a list/poll fetch (a
  // JOIN on the read path) — not on the direct response to sending a
  // message, since a sender always already knows their own username. See
  // server/src/db/messages.repo.ts's MessageWithSender for the same split.
  sender_username?: string;
  sequence_number: number;
  client_message_id: string;
  body: string;
  created_at: string;
}

// A message the UI has shown before the server confirmed it. `status`
// lets the UI render the right affordance and distinguish a real row from
// a placeholder:
//  - 'queued'  — sitting in the client-side outbox (realtime/outbox.ts),
//                not currently in flight; either the socket was
//                disconnected when this was sent, or it was in flight and
//                got knocked back to 'queued' by a disconnect before an
//                ack arrived (Phase 11 — see ChatRoomPage's 'disconnect'
//                handler).
//  - 'pending' — handed to a connected socket, awaiting message_ack.
//  - 'failed'  — the server sent back a definitive (non-retryable)
//                rejection for this exact clientMessageId; it has already
//                been dropped from the outbox and will not be retried
//                automatically.
export interface OptimisticMessage extends Omit<Message, 'id' | 'sequence_number'> {
  id: number | null;
  sequence_number: number | null;
  status: 'queued' | 'pending' | 'failed';
}

export type DisplayMessage = Message | OptimisticMessage;

export interface MessagesPage {
  messages: Message[];
  latest_sequence_number: number;
  has_more: boolean;
  next_cursor: string | null;
}

// What the server emits in response to join_room's optional sinceSequence
// (Phase 12 — ARCHITECTURE_V2.md §7). Deliberately plain numeric fields, not
// the opaque base64 cursor the HTTP pagination API uses (cursor.ts): a
// socket client already tracks the numeric highest sequence_number it's
// seen for this room in memory (it's exactly the value it just sent AS
// sinceSequence), so there's no "client should never construct one by hand"
// concern here the way there is for HTTP's next_cursor — this cursor never
// leaves this one round trip.
export interface CatchUpBatch {
  roomId: number;
  messages: Message[];
  hasMore: boolean;
  latestSequenceNumber: number;
}

// Phase 13 — ARCHITECTURE_V2.md §9. Reference-counted server-side: this
// only ever arrives when a user's online sockets go from zero to one
// (status: 'online') or one-to-zero AND the grace period elapses with no
// reconnect (status: 'offline') — never once per socket. A client that
// tracks a Set<userId> keyed by this event's userId already has correct
// multi-tab/multi-device semantics for free, with no client-side reference
// counting of its own to get wrong.
export interface PresenceEvent {
  userId: number;
  status: 'online' | 'offline';
}

// Phase 14 — ARCHITECTURE_V2.md §10. Identical shape for both 'typing' and
// 'stopped_typing' — deliberately minimal (no username, no timestamp): the
// server is a pure relay with zero DB access on this path, so it has
// nothing more to attach than what the sender itself sent. The receiving
// client resolves a display name itself, best-effort, from messages it has
// already seen from that sender (see ChatRoomPage's resolveDisplayName).
export interface TypingEvent {
  userId: number;
  roomId: number;
}
