import bcrypt from 'bcrypt';

// 12 rounds is the commonly recommended floor for bcrypt in 2026 — slow
// enough to make brute-forcing a leaked hash expensive, fast enough that
// login doesn't feel sluggish. See LEARNING_NOTES.md (kept locally) for why
// this needs to be slow at all.
const SALT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Precomputed once at startup, never tied to a real account. Used only so
// that a login attempt against a non-existent email pays the exact same
// bcrypt cost as one against a real email with the wrong password — see
// verifyPasswordOrDummy below and its caller in auth.routes.ts.
const DUMMY_HASH_FOR_TIMING = bcrypt.hashSync('timing-attack-mitigation-fixed-value', SALT_ROUNDS);

/**
 * Same as verifyPassword, but when `hash` is undefined (no matching user
 * row), compares against a fixed dummy hash instead of skipping the
 * comparison. Without this, `!user || !(await verifyPassword(...))` never
 * calls bcrypt for a non-existent email — bcrypt.compare is deliberately
 * slow, so that short-circuit is measurable over the network and leaks
 * which emails are registered, even though both cases return an identical
 * error message and status code.
 */
export function verifyPasswordOrDummy(plain: string, hash: string | undefined): Promise<boolean> {
  return bcrypt.compare(plain, hash ?? DUMMY_HASH_FOR_TIMING);
}
