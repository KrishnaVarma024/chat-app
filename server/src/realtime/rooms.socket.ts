import type { Server, Socket } from 'socket.io';
import { checkRoomMembership } from '../rooms/rooms.middleware';
import { listMessagesAfter, DEFAULT_PAGE_LIMIT } from '../db/messages.repo';
import { AppError, ValidationError } from '../errors';
import { logger } from '../observability/logger';
import type { AuthedSocketData } from './socketAuth.middleware';

/**
 * Socket.IO room names share one flat string namespace across the whole
 * server (unlike Express routes, which are scoped by path). Prefixing a
 * plain numeric room id keeps it from ever colliding with some other
 * future room-naming scheme — e.g. a per-user notification room — that
 * might otherwise pick an overlapping string.
 */
export function roomKey(roomId: number): string {
  return `room:${roomId}`;
}

/**
 * A Socket.IO room containing every socket one USER has open (every tab,
 * every device). Lets the server address a person rather than a connection —
 * which is what "this user was removed from room 7" needs: evict all of their
 * sockets from `room:7`, without having to enumerate them.
 */
export function userKey(userId: number): string {
  return `user:${userId}`;
}

/**
 * Same error SHAPE the HTTP API already returns:
 * { error: { code, message } }. A client-side error handler that already
 * knows how to read an HTTP error body doesn't need a second, socket-
 * specific parsing path — one error contract for the whole app, regardless
 * of which transport produced it.
 */
/**
 * Exported (not just used locally) because Phase 10's messages.socket.ts
 * needs the exact same error shape for send_message failures — one
 * function producing `{ error: { code, message } }`, regardless of which
 * socket event triggered it. `extra` merges in event-specific context
 * (e.g. send_message attaches `clientMessageId` so the client can tell
 * *which* in-flight optimistic bubble a given error belongs to, instead of
 * guessing from a timeout — see ChatRoomPage.tsx's handleSocketError).
 */
export function emitError(socket: Socket, err: unknown, extra: Record<string, unknown> = {}): void {
  if (err instanceof AppError) {
    socket.emit('error', { error: { code: err.code, message: err.message }, ...extra });
    return;
  }
  logger.error('unexpected socket error', {
    socketId: socket.id,
    error: err instanceof Error ? err.message : String(err),
  });
  socket.emit('error', { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' }, ...extra });
}

/**
 * Registers this socket's room-related event handlers. Called once per
 * connection from realtime/socket.ts's 'connection' listener.
 *
 * join_room/leave_room deliberately call the SAME checkRoomMembership
 * function rooms.middleware.ts's Express middleware calls — this is the
 * "one source of truth for authorization" principle from
 * ARCHITECTURE_V2.md §4/§15: a room's membership rules live in exactly one
 * place, regardless of which transport is asking.
 */
export function registerRoomHandlers(_io: Server, socket: Socket): void {
  const { userId } = socket.data as AuthedSocketData;

  socket.on('join_room', async (payload: { roomId?: number; sinceSequence?: number }) => {
    const roomId = Number(payload?.roomId);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return emitError(socket, new ValidationError('Invalid room id'));
    }

    // Optional on purpose: a client's very first-ever join of a room (no
    // local history at all) has no sequence number to catch up FROM — it
    // just loaded the latest page over HTTP, same as always. Every rejoin
    // after that (a reconnect, or a follow-up page request below) always
    // has one, because the client tracks the highest sequence_number it's
    // ever displayed for this room. `undefined` and "not a valid integer"
    // are treated identically: skip catch-up, just join.
    let sinceSequence: number | undefined;
    if (payload?.sinceSequence !== undefined) {
      const parsed = Number(payload.sinceSequence);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return emitError(socket, new ValidationError('Invalid sinceSequence'));
      }
      sinceSequence = parsed;
    }

    try {
      await checkRoomMembership(roomId, userId);

      // See ARCHITECTURE_V2.md §7. The socket joins the live room FIRST, and
      // only then runs the catch-up query. Phase 12 did it the other way
      // round ("query, then join, so nothing is delivered twice") and
      // Phase 16's seam test proved that ordering is wrong:
      //
      //   query-then-join:  a message committed AFTER the query's snapshot
      //   but BEFORE the join lands in neither place — it is not in the
      //   batch (too late for the snapshot) and not pushed live (this
      //   socket is not in the room yet). The client never learns it
      //   exists, and nothing ever tells it to look.
      //
      //   join-then-query: that same message is pushed live (we are in the
      //   room) and/or included in the batch (the query runs after the
      //   join, so it sees everything the live path could miss). Worst
      //   case it arrives TWICE — which the client already absorbs, since
      //   mergeMessages dedupes by client_message_id.
      //
      // The two failure modes are not symmetric: a duplicate is invisible,
      // a gap is silent data loss. Choose the duplicate. The consequence is
      // that live new_message events can now arrive BEFORE the catch_up
      // batch, so the client must not treat "the newest thing I've seen" as
      // "everything up to here is known" — see client/src/realtime/catchUpCursor.ts.
      //
      // Safe to call even if this socket already joined this room earlier
      // in the same connection (Socket.IO's room bookkeeping is a Set under
      // the hood): that is what lets a follow-up page request reuse this
      // exact event — the client re-emits join_room with the previous
      // page's end as sinceSequence, and re-joining is a harmless no-op.
      await socket.join(roomKey(roomId));

      // Check membership AGAIN, now that we are in the room. The check at the
      // top and the join above are two separate steps with awaits between
      // them; if the user's membership ended in that gap, the eviction in
      // socket.ts (socketsLeave) ran before this socket was in the room and
      // so could not remove it — leaving a zombie member who receives every
      // push. Re-verifying after the join closes the window from both sides:
      // either the leave's eviction finds this socket already in the room, or
      // this check sees the membership row already gone. (Joins are rare, so
      // the extra query is cheap insurance for an authorization boundary.)
      try {
        await checkRoomMembership(roomId, userId);
      } catch (err) {
        await socket.leave(roomKey(roomId));
        throw err;
      }

      if (sinceSequence !== undefined) {
        const { messages, hasMore } = await listMessagesAfter(roomId, sinceSequence, DEFAULT_PAGE_LIMIT);
        const latestSequenceNumber =
          messages.length > 0 ? messages[messages.length - 1].sequence_number : sinceSequence;
        socket.emit('catch_up', { roomId, messages, hasMore, latestSequenceNumber });
      }

      socket.emit('joined_room', { roomId });
      logger.info('socket joined room', { userId, roomId, socketId: socket.id, sinceSequence });
    } catch (err) {
      emitError(socket, err);
    }
  });

  socket.on('leave_room', async (payload: { roomId?: number }) => {
    const roomId = Number(payload?.roomId);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return emitError(socket, new ValidationError('Invalid room id'));
    }
    await socket.leave(roomKey(roomId));
    socket.emit('left_room', { roomId });
    logger.info('socket left room', { userId, roomId, socketId: socket.id });
  });
}
