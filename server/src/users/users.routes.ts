import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../auth/auth.middleware';
import { findUserById } from '../db/users.repo';
import { AuthError } from '../errors';

export const usersRouter = Router();

usersRouter.get('/me', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const user = await findUserById(req.user!.id);
    if (!user) {
      // Valid token, but the account behind it is gone — treat as
      // unauthenticated rather than a generic 404/500.
      throw new AuthError('User no longer exists');
    }
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.created_at,
    });
  } catch (err) {
    next(err);
  }
});
