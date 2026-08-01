import crypto from 'node:crypto';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const REFRESH_COOKIE_NAME = 'refresh_token';

/**
 * 256 bits of randomness, hex-encoded. Deliberately NOT a JWT — a refresh
 * token has to be revocable on demand (logout, reuse detection), and a
 * self-contained signed token can't be un-issued before it expires. An
 * opaque string that's looked up in the DB can be killed instantly.
 */
export function generateRawRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * We only ever store this. The raw token exists in exactly two places: the
 * client's cookie jar, and briefly in memory on the server while handling
 * the request that issued or is verifying it — never in the database.
 */
export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
