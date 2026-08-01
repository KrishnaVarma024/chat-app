import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPasswordOrDummy } from './password';
import { signAccessToken } from './tokens';
import { createUser, findUserByEmail } from '../db/users.repo';
import { ValidationError, AuthError, ConflictError } from '../errors';

export const authRouter = Router();

const registerSchema = z.object({
  username: z.string().min(3).max(32),
  email: z.string().email(),
  password: z.string().min(8),
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { username, email, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await createUser({ username, email, passwordHash });
    } catch (err) {
      // Postgres unique_violation — let the DB constraint be the source of
      // truth for "is this taken", not a separate SELECT-then-INSERT check
      // that would itself race under concurrent signups.
      if (isUniqueViolation(err)) {
        throw new ConflictError('Username or email already in use');
      }
      throw err;
    }

    const accessToken = signAccessToken({ sub: user.id });
    res.status(201).json({
      user: { id: user.id, username: user.username, email: user.email },
      accessToken,
    });
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { email, password } = parsed.data;

    const user = await findUserByEmail(email);
    // verifyPasswordOrDummy always runs a bcrypt.compare, even when `user`
    // is undefined — that's what makes "same error for no-such-user and
    // wrong-password" actually true in wall-clock time, not just in the
    // response body. See password.ts for why that distinction matters.
    const passwordValid = await verifyPasswordOrDummy(password, user?.password_hash);
    if (!user || !passwordValid) {
      throw new AuthError('Invalid email or password');
    }

    const accessToken = signAccessToken({ sub: user.id });
    res.status(200).json({
      user: { id: user.id, username: user.username, email: user.email },
      accessToken,
    });
  } catch (err) {
    next(err);
  }
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
