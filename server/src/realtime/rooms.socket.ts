import type { Server, Socket } from 'socket.io';
import { checkRoomMembership } from '../rooms/rooms.middleware';
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

  socket.on('join_room', async (payload: { roomId?: number }) => {
    const roomId = Number(payload?.roomId);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return emitError(socket, new ValidationError('Invalid room id'));
    }

    try {
      await checkRoomMembership(roomId, userId);
      await socket.join(roomKey(roomId));
      socket.emit('joined_room', { roomId });
      logger.info('socket joined room', { userId, roomId, socketId: socket.id });
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
