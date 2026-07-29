import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  sub: number; // user id
}

// The JWT spec defines `sub` as a StringOrURI, and jsonwebtoken's own types
// reflect that (JwtPayload.sub is `string | undefined`) — so we store it as
// a string on the wire and convert at the edges, rather than fighting the
// library's types with a cast.
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ sub: String(payload.sub) }, env.jwtSecret, {
    expiresIn: env.accessTokenTtl as jwt.SignOptions['expiresIn'],
  });
}

/** Throws if the token is malformed, expired, or signed with a different secret. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.jwtSecret);
  if (typeof decoded === 'string' || !decoded.sub) {
    throw new Error('Unexpected token payload shape');
  }
  return { sub: Number(decoded.sub) };
}
