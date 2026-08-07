import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

// 12 rounds is the commonly recommended floor for bcrypt in 2026 — slow
// enough to make brute-forcing a leaked hash expensive, fast enough that
// login doesn't feel sluggish. See LEARNING_NOTES.md (kept locally) for why
// this needs to be slow at all.
const SALT_ROUNDS = 12;

// bcrypt silently truncates its input at 72 BYTES — anything past that is
// ignored with no error, so two different passwords sharing the same first
// 72 bytes hash identically. Pre-hashing with SHA-256 first converts any
// input length into a fixed 32-byte, full-entropy value (64 hex chars,
// still well under 72 bytes), so bcrypt's own hashing never actually
// truncates anything meaningful. This is the standard mitigation for that
// limitation — see the pre-hashing discussion in the bcrypt ecosystem
// (e.g. Monterail's "More Secure Passwords in Bcrypt" writeup).
//
// BREAKING CHANGE NOTE: this changes what bcrypt actually hashes, so any
// password hash generated before this change (raw plaintext -> bcrypt) will
// no longer verify against a login attempt with the same password (which
// now goes through sha256Hex -> bcrypt). Fine to ship as-is pre-launch with
// no real users yet — re-run `npm run seed` afterward so the seeded
// accounts get rehashed under the new scheme. In a system with real
// existing users, this would need a migration path (e.g. a hash-version
// marker per user, verify-then-rehash-on-next-login), not a silent swap.
function sha256Hex(plain: string): string {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(sha256Hex(plain), SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(sha256Hex(plain), hash);
}

// Precomputed once at startup, never tied to a real account. Used only so
// that a login attempt against a non-existent email pays the exact same
// bcrypt cost as one against a real email with the wrong password — see
// verifyPasswordOrDummy below and its caller in auth.routes.ts.
const DUMMY_HASH_FOR_TIMING = bcrypt.hashSync(sha256Hex('timing-attack-mitigation-fixed-value'), SALT_ROUNDS);

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
  return bcrypt.compare(sha256Hex(plain), hash ?? DUMMY_HASH_FOR_TIMING);
}
