import type { Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/tokens';

export interface AuthedSocketData {
  userId: number;
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
