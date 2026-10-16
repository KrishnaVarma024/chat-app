import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  sub: number; // user id
}

/** What a successfully VERIFIED token yields: the payload above plus the
 * `exp` claim (seconds since epoch). Callers that only authenticate a
 * request (requireAuth) ignore `exp`; the socket layer (Phase 15) needs it
 * to know when a long-lived connection's credential runs out. */
export interface VerifiedAccessToken extends AccessTokenPayload {
  exp: number;
}

// The JWT spec defines `sub` as a StringOrURI, and jsonwebtoken's own types
// reflect that (JwtPayload.sub is `string | undefined`) — so we store it as
// a string on the wire and convert at the edges, rather than fighting the
// library's types with a cast.
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ sub: String(payload.sub) }, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: env.accessTokenTtl as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Throws if the token is malformed, expired, signed with a different secret,
 * or signed with any algorithm other than HS256.
 *
 * That last case doesn't happen by accident — jsonwebtoken's own default,
 * when given a plain secret string and no explicit `algorithms` option, is
 * to accept HS256, HS384, *and* HS512 (see the jsonwebtoken README). This
 * app only ever issues HS256, so without pinning it here, a token forged
 * with the same secret but a different algorithm in its header would still
 * verify — not exploitable by anyone who doesn't already have JWT_SECRET,
 * but unnecessary attack surface for a one-line fix. Standard OWASP
 * guidance on JWTs: never trust the `alg` the token claims for itself,
 * always enforce an explicit allowlist server-side.
 */
export function verifyAccessToken(token: string): VerifiedAccessToken {
  const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
  // `exp` is required, not optional: signAccessToken always sets it, so a
  // token without one wasn't issued by this app — and a credential that
  // never expires is exactly what the socket layer's expiry timers (which
  // have nothing to count down to without it) must never be handed.
  if (typeof decoded === 'string' || !decoded.sub || typeof decoded.exp !== 'number') {
    throw new Error('Unexpected token payload shape');
  }
  return { sub: Number(decoded.sub), exp: decoded.exp };
}
