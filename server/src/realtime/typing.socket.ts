import type { Server, Socket } from 'socket.io';
import { ValidationError, ForbiddenError } from '../errors';
import { roomKey, emitError } from './rooms.socket';
import type { AuthedSocketData } from './socketAuth.middleware';

/**
 * Typing indicators: ARCHITECTURE_V2.md §10. A pure relay — no database
 * access anywhere on this path, not even a membership check. That's a
 * deliberate trade-off for ephemeral, high-frequency, low-stakes data: a
 * burst of keystrokes turning into a burst of DB round trips just to
 * re-verify something join_room already verified moments earlier would be
 * real cost for a feature nobody notices the correctness of.
 *
 * That doesn't mean "no authorization at all," though. Socket.IO's
 * `socket.to(roomName)` will happily broadcast to a room name string
 * regardless of whether the SENDING socket itself ever joined that room —
 * `.to()` targets an arbitrary room name, it doesn't check the caller's
 * own membership. Without any gate at all, a connected-but-unrelated user
 * who simply knows (or guesses) another room's numeric id could spoof a
 * typing indicator into a room they were never authorized to know exists.
 * `socket.rooms` is the fix that costs nothing: it's Socket.IO's own
 * in-memory Set of rooms THIS socket has actually `join()`-ed, and
 * join_room already ran the real, DB-backed membership check before ever
 * adding a room to that set. Checking membership in that Set is a plain
 * in-memory lookup — zero database access, same as the rest of this file
 * — while still closing the spoofing gap, because only a socket that
 * already passed join_room's real check can be in it.
 */
export function registerTypingHandlers(_io: Server, socket: Socket): void {
  const { userId } = socket.data as AuthedSocketData;

  function requireJoinedRoom(payload: { roomId?: number }): number | null {
    const roomId = Number(payload?.roomId);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      emitError(socket, new ValidationError('Invalid room id'));
      return null;
    }
    if (!socket.rooms.has(roomKey(roomId))) {
      emitError(socket, new ForbiddenError('You are not a member of this room'));
      return null;
    }
    return roomId;
  }

  socket.on('typing_start', (payload: { roomId?: number }) => {
    const roomId = requireJoinedRoom(payload);
    if (roomId === null) return;
    // socket.to(...), not io.to(...) — excludes the sender, same reasoning
    // as new_message's broadcast (Phase 10): you already know you're
    // typing, you don't need an echo of your own event.
    socket.to(roomKey(roomId)).emit('typing', { userId, roomId });
  });

  socket.on('typing_stop', (payload: { roomId?: number }) => {
    const roomId = requireJoinedRoom(payload);
    if (roomId === null) return;
    socket.to(roomKey(roomId)).emit('stopped_typing', { userId, roomId });
  });

  // Deliberately NO 'disconnect' handler here emitting a synthetic
  // stopped_typing. ARCHITECTURE_V2.md §10 puts that responsibility on the
  // RECEIVING client's own auto-clear timeout instead — a client that
  // crashes or loses its connection mid-keystroke, without ever emitting
  // typing_stop, is exactly the case that timeout exists to cover. Adding
  // server-side cleanup here would be a second mechanism doing the same
  // job the receiver's timeout already has to do unconditionally anyway
  // (nothing here could distinguish "crashed" from "network blip about to
  // recover" in time to matter), for a feature where being briefly wrong
  // is explicitly an acceptable cost.
}
