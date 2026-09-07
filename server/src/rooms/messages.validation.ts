import { z } from 'zod';

/**
 * Shared between the HTTP `POST /rooms/:roomId/messages` route
 * (rooms.routes.ts) and the `send_message` socket event (realtime/
 * messages.socket.ts, Phase 10) — same "one source of truth" reasoning as
 * `checkRoomMembership` in rooms.middleware.ts. A message's shape (body
 * length, clientMessageId format) is validated in exactly one place, so
 * the two transports can never quietly drift apart on what counts as a
 * valid message.
 */
export const sendMessageSchema = z.object({
  body: z.string().min(1).max(4000),
  // Client-generated — this is the idempotency key, see messages.repo.ts.
  clientMessageId: z.string().uuid(),
});
