import type { Server, Socket } from 'socket.io';
import { checkRoomMembership } from '../rooms/rooms.middleware';
import { sendMessageSchema } from '../rooms/messages.validation';
import { sendMessage } from '../db/messages.repo';
import { ValidationError } from '../errors';
import { logger } from '../observability/logger';
import { roomKey, emitError } from './rooms.socket';
import type { AuthedSocketData } from './socketAuth.middleware';

/**
 * Registers this socket's message-related event handlers. Called once per
 * connection from realtime/socket.ts, alongside registerRoomHandlers —
 * Phase 9 built the "join a room" transport, this builds "do something
 * inside it." See ARCHITECTURE_V2.md §5.
 */
export function registerMessageHandlers(_io: Server, socket: Socket): void {
  const { userId } = socket.data as AuthedSocketData;

  socket.on('send_message', async (payload: { roomId?: number; body?: string; clientMessageId?: string }) => {
    const roomId = Number(payload?.roomId);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return emitError(socket, new ValidationError('Invalid room id'), { clientMessageId: payload?.clientMessageId });
    }

    const parsed = sendMessageSchema.safeParse({ body: payload?.body, clientMessageId: payload?.clientMessageId });
    if (!parsed.success) {
      return emitError(socket, new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input'), {
        clientMessageId: payload?.clientMessageId,
      });
    }

    try {
      // Re-checked independently of whether this socket ever called
      // join_room for this room. A roomId in this payload is exactly as
      // trustworthy as a roomId in an HTTP URL param — i.e. not at all
      // until this line confirms it — regardless of what socket.rooms
      // (Socket.IO's own join bookkeeping) currently says. Same
      // single-source-of-truth function the HTTP route and join_room both
      // call (rooms.middleware.ts).
      await checkRoomMembership(roomId, userId);

      const message = await sendMessage({
        roomId,
        senderId: userId,
        clientMessageId: parsed.data.clientMessageId,
        body: parsed.data.body,
      });

      // Ack goes to the sender ONLY, and it's plain MessageRow — no
      // sender_username attached, same reasoning as the HTTP POST response
      // (messages.repo.ts): the sender already knows their own name, the
      // optimistic bubble already rendered it locally. mergeMessages keys
      // on client_message_id, so this ack slots into the exact same
      // reconciliation path the old HTTP confirmation used.
      socket.emit('message_ack', message);

      // Broadcast goes to everyone else already in this Socket.IO room —
      // socket.to(...), not io.to(...), deliberately excludes the sender
      // (they already got their own copy via message_ack; echoing it back
      // would just make every client de-dupe for no reason). THIS one DOES
      // carry sender_username, from the single per-connection lookup in
      // socket.ts — recipients have no other way to know who sent it.
      // Awaited here (not read as a plain field) because handlers are
      // registered before that lookup necessarily resolves — see
      // AuthedSocketData's doc comment. In virtually every real send this
      // resolves instantly (the promise settled long before the user typed
      // anything); it only actually waits on a message sent in the same
      // tick as the connection itself.
      const username = (await (socket.data as AuthedSocketData).usernameReady) ?? undefined;
      socket.to(roomKey(roomId)).emit('new_message', { ...message, sender_username: username });

      logger.info('message sent via socket', { userId, roomId, sequence: message.sequence_number });
    } catch (err) {
      emitError(socket, err, { clientMessageId: parsed.data.clientMessageId });
    }
  });
}
