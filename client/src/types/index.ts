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

// A message the UI has shown before the server confirmed it — see
// api/messages.ts sendMessageOptimistic. `status` lets the UI render a
// "sending..." affordance and distinguish a real row from a placeholder.
export interface OptimisticMessage extends Omit<Message, 'id' | 'sequence_number'> {
  id: number | null;
  sequence_number: number | null;
  status: 'pending' | 'failed';
}

export type DisplayMessage = Message | OptimisticMessage;

export interface MessagesPage {
  messages: Message[];
  latest_sequence_number: number;
  has_more: boolean;
  next_cursor: string | null;
}
