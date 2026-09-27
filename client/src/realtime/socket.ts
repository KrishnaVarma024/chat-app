import { io, type Socket } from 'socket.io-client';
import { API_BASE } from '../api/client';
import { getAccessToken } from '../api/tokenStore';
import { enqueueMessage, flushQueueOverSocket, removeFromQueue } from './outbox';

// Module-level singleton, same reasoning as tokenStore.ts: there is exactly
// ONE socket connection for the whole app (not one per component that
// happens to need it), so components subscribe to it rather than each
// creating their own. Phase 10 wires this into the chat view; Phase 9 only
// needs connect/join/leave to exist and be verifiable.
let socket: Socket | null = null;

export function connectSocket(): Socket {
  if (socket) return socket;

  socket = io(API_BASE, {
    // A function, not a plain object — Socket.IO calls this fresh on every
    // connection attempt, including every reconnect. Reading
    // getAccessToken() at call time (not once, up front) means a token
    // refreshed in the meantime is picked up automatically, without this
    // module needing to know anything about when refreshes happen.
    auth: (cb) => cb({ token: getAccessToken() }),

    // Explicit, not left at library defaults — ARCHITECTURE_V2.md §6.
    // Exponential backoff (delay doubles each failed attempt, up to a
    // ceiling) exists so a server restart doesn't get hit by every
    // disconnected client retrying in the same instant it comes back up —
    // a self-inflicted thundering herd at the worst possible moment.
    // Jitter (randomizationFactor) then spreads those retries across
    // CLIENTS too, not just across time for one client, so the herd never
    // forms even among clients that all disconnected at the same moment.
    reconnection: true,
    reconnectionDelay: 1000, // first retry ~1s after a disconnect
    reconnectionDelayMax: 30000, // never wait longer than 30s between attempts
    randomizationFactor: 0.5, // +/-50% jitter applied to every computed delay
    reconnectionAttempts: Infinity, // a chat app shouldn't give up and force a manual refresh
  });

  // Registered once, here, at socket-creation time — NOT inside
  // ChatRoomPage — because message durability is a property of the
  // connection itself, not of whichever room UI happens to be mounted.
  // A message queued while the user was on room A must still flush and
  // get acked even if they've since navigated to room B (or the room
  // list) before the reconnect happens.
  socket.on('connect', () => flushQueueOverSocket(socket!));
  socket.on('message_ack', (msg: { client_message_id: string }) => {
    removeFromQueue(msg.client_message_id);
  });
  socket.on('error', (payload: { clientMessageId?: string }) => {
    // Only a send_message failure names a clientMessageId (Phase 10's
    // emitError `extra` argument) — a bad join_room has nothing to remove
    // here, which this check correctly no-ops on.
    if (payload?.clientMessageId) removeFromQueue(payload.clientMessageId);
  });

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.close();
  socket = null;
}

/**
 * `sinceSequence` is optional (Phase 12 — ARCHITECTURE_V2.md §7): omit it
 * for a room's very first-ever join, where there's no local history to
 * catch up FROM yet (ChatRoomPage's initial HTTP load already fetched the
 * latest page). Every other call site — every reconnect, and every
 * follow-up page request for a large gap — passes the highest
 * sequence_number this client has ever displayed for this room, so the
 * server knows exactly what to send back in a 'catch_up' batch before
 * live delivery resumes.
 */
export function joinRoom(roomId: number, sinceSequence?: number): void {
  connectSocket().emit('join_room', { roomId, sinceSequence });
}

export function leaveRoom(roomId: number): void {
  getSocket()?.emit('leave_room', { roomId });
}

/**
 * Fire-and-forget, same as joinRoom/leaveRoom — there's no return value to
 * await, because confirmation doesn't come back as this call's result. It
 * comes back later as either a 'message_ack' or an 'error' event carrying
 * the same clientMessageId, which is what ChatRoomPage actually listens
 * for (see server/src/realtime/messages.socket.ts).
 *
 * Phase 11 change: this no longer emits directly. It ALWAYS enqueues
 * first (the durable "intent to send"), then asks the outbox to flush —
 * which is a no-op if the socket happens to be disconnected right now,
 * and an immediate emit if it isn't. Enqueue-then-flush, rather than
 * "try to emit, fall back to queueing on failure," is what makes the
 * "message that was in flight at the moment of disconnect" case (Phase
 * 11's DoD) safe by construction: there's no separate code path for
 * "already sent, just waiting" versus "never got out the door" — a
 * message is always sitting in the queue until an ack or a definitive
 * error removes it, so a disconnect at ANY point after enqueue just means
 * the next 'connect' event flushes it again, and idempotency (Phase 4)
 * guarantees a redundant resend is harmless.
 */
export function sendChatMessage(roomId: number, body: string, clientMessageId: string): void {
  enqueueMessage(roomId, body, clientMessageId);
  flushQueueOverSocket(connectSocket());
}

/** Lets callers (ChatRoomPage) decide a just-sent message's INITIAL
 * optimistic status without duplicating this module's notion of
 * "connected" — 'queued' if there was nowhere to send it yet, 'pending'
 * if it should be in flight right now. Either way the eventual outcome
 * (ack or error) arrives the same way. */
export function isSocketConnected(): boolean {
  return socket?.connected ?? false;
}
