import type { Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/tokens';

export interface AuthedSocketData {
  userId: number;
  // NOT set by this middleware — kicked off once, right after 'connection'
  // fires, by a single findUserById lookup in realtime/socket.ts (kept out
  // of the handshake token itself so this middleware still mirrors
  // requireAuth exactly: verify the JWT, nothing else, same as every HTTP
  // request — a socket's auth boundary doesn't grow extra DB calls just
  // because a later feature wants a display name).
  //
  // A PROMISE, not the resolved value — deliberately. Event handlers are
  // registered synchronously, in the same tick 'connection' fires, so that
  // a client emitting immediately after connecting can never race ahead of
  // its own handlers existing (Socket.IO doesn't buffer an event against a
  // listener that isn't registered yet — this was a real bug, caught by
  // the Phase 10 verification script hanging). That means the username
  // lookup is still in flight when handlers are attached, so anything that
  // needs it (messages.socket.ts) awaits this shared promise instead of
  // reading a plain field — first awaiter pays for the real query, every
  // later one gets an already-resolved promise. Resolves to null if the
  // account behind a still-valid token turned out not to exist.
  usernameReady: Promise<string | null>;
  // Set as a side effect of usernameReady resolving successfully — a
  // synchronous convenience for anything that runs later and doesn't want
  // to re-await an already-settled promise. Don't read this without either
  // having awaited usernameReady first, or being certain enough time has
  // passed (e.g. handling this socket's second event) that it must have
  // settled already.
  username?: string;
}

/**
 * Runs once per handshake, BEFORE the connection is ever accepted. A socket
 * that fails this never gets a socket.id, never reaches an 'connection'
 * listener, and never touches presence or room state — there is no window
 * where a half-authenticated socket exists.
 *
 * Deliberately mirrors requireAuth (auth/auth.middleware.ts): same token,
 * same verification function (verifyAccessToken), same posture of not
 * distinguishing "missing" vs "malformed" vs "expired" in the error it
 * returns. The only real difference is where the token travels — there's
 * no Authorization header at the transport level Socket.IO negotiates a
 * connection over, so the token rides in the handshake's `auth` payload
 * instead, which the client attaches itself (see client/src/realtime/socket.ts).
 */
export function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): void {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string' || token.length === 0) {
    return next(new Error('UNAUTHORIZED'));
  }

  try {
    const payload = verifyAccessToken(token);
    (socket.data as AuthedSocketData).userId = payload.sub;
    next();
  } catch {
    next(new Error('UNAUTHORIZED'));
  }
}
