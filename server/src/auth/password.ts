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
