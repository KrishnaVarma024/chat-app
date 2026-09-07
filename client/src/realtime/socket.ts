import { io, type Socket } from 'socket.io-client';
import { API_BASE } from '../api/client';
import { getAccessToken } from '../api/tokenStore';

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
    // connection attempt, including every reconnect (Phase 11). Reading
    // getAccessToken() at call time (not once, up front) means a token
    // refreshed in the meantime is picked up automatically, without this
    // module needing to know anything about when refreshes happen.
    auth: (cb) => cb({ token: getAccessToken() }),
    // Phase 9 verifies the bare handshake only — reconnection behavior
    // (backoff, jitter, max attempts) is Phase 11's job, so it's left at
    // Socket.IO's defaults here rather than half-configured early.
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

export function joinRoom(roomId: number): void {
  connectSocket().emit('join_room', { roomId });
}

export function leaveRoom(roomId: number): void {
  getSocket()?.emit('leave_room', { roomId });
}

/**
 * Fire-and-forget, same as joinRoom/leaveRoom — there's no return value to
 * await, because confirmation doesn't come back as this call's result. It
 * comes back later as either a 'message_ack' or an 'error' event carrying
 * the same clientMessageId, which is what ChatRoomPage actually listens
 * for (see server/src/realtime/messages.socket.ts). This mirrors how the
 * old HTTP sendMessage() call used to work from the CALLER's point of view
 * (optimistic bubble now, confirmation later) — only the transport
 * carrying that confirmation changed.
 */
export function sendChatMessage(roomId: number, body: string, clientMessageId: string): void {
  connectSocket().emit('send_message', { roomId, body, clientMessageId });
}
