import crypto from 'node:crypto';
import { pool } from './pool';
import { generateRawRefreshToken, hashRefreshToken, REFRESH_TOKEN_TTL_MS } from '../auth/refresh-tokens';

/** Called on register/login: starts a brand new token family for this session. */
export async function createRefreshTokenFamily(userId: number): Promise<string> {
  const id = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  const rawToken = generateRawRefreshToken();
  const tokenHash = hashRefreshToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, familyId, tokenHash, expiresAt]
  );

  return rawToken;
}

export type RotateResult =
  | { kind: 'success'; userId: number; rawToken: string }
  | { kind: 'reuse' }
  | { kind: 'invalid' };

/**
 * Atomically rotates a refresh token: the presented token is revoked and a
 * new one is issued in its place, in the same family. If the presented
 * token is already revoked (already rotated away, or logged out) rather
 * than simply unknown, that's reuse of a dead credential — every token in
 * its family is revoked in response, on the assumption it was stolen.
 *
 * The claim step is a single UPDATE ... WHERE revoked_at IS NULL, the same
 * pattern as the message sequence counter in Phase 0: Postgres's row lock
 * is what makes this safe if the same token is presented twice at once —
 * only one request can ever win the race and see 1 row returned.
 */
export async function rotateRefreshToken(rawToken: string): Promise<RotateResult> {
  const tokenHash = hashRefreshToken(rawToken);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newId = crypto.randomUUID();

    // Deliberately does NOT set replaced_by here. replaced_by is a foreign
    // key into this same table, and the row it needs to point at (newId)
    // doesn't exist yet — setting it in this statement fails Postgres's
    // (non-deferred) FK check immediately, before the INSERT below ever
    // runs. revoked_at alone is enough to make this the atomic, race-safe
    // "claim" — replaced_by gets linked in a follow-up UPDATE once the new
    // row actually exists.
    const claim = await client.query<{ id: string; user_id: number; family_id: string }>(
      `UPDATE refresh_tokens
       SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING id, user_id, family_id`,
      [tokenHash]
    );

    if (claim.rows.length === 0) {
      const existing = await client.query<{ family_id: string; revoked_at: Date | null }>(
        `SELECT family_id, revoked_at FROM refresh_tokens WHERE token_hash = $1`,
        [tokenHash]
      );

      if (existing.rows.length > 0 && existing.rows[0].revoked_at !== null) {
        // A legitimate client only ever presents the *latest* token it was
        // handed — it can't still have a token that's already revoked
        // unless something else used it first (theft) or it's being
        // replayed after logout. Either way: kill the whole family.
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
          [existing.rows[0].family_id]
        );
        await client.query('COMMIT');
        return { kind: 'reuse' };
      }

      // Doesn't exist at all, or exists but expired — neither implies
      // compromise, so no family-wide revocation, just "try again".
      await client.query('ROLLBACK');
      return { kind: 'invalid' };
    }

    const { id: claimedId, user_id: userId, family_id: familyId } = claim.rows[0];
    const newRawToken = generateRawRefreshToken();
    const newTokenHash = hashRefreshToken(newRawToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await client.query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId, userId, familyId, newTokenHash, expiresAt]
    );

    // Now that the new row exists, link the old one to it — this is the
    // step that would have violated the FK if done earlier.
    await client.query(`UPDATE refresh_tokens SET replaced_by = $1 WHERE id = $2`, [newId, claimedId]);

    await client.query('COMMIT');
    return { kind: 'success', userId, rawToken: newRawToken };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Logout: revoke the single presented token. Nothing replaces it, so this
 * ends the session — rotation always keeps exactly one live token per
 * family, so revoking "the current one" with nothing to replace it is
 * equivalent to killing the family, just without touching its history. */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashRefreshToken(rawToken);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}
