import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from './tokens';
import { AuthError } from '../errors';

export interface AuthedRequest extends Request {
  user?: { id: number };
}

/**
 * Verifies the Authorization: Bearer <token> header and attaches req.user.
 * Deliberately gives the same generic error for "missing", "malformed", and
 * "expired" — an attacker probing this endpoint shouldn't learn which.
 */
export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AuthError('Missing or invalid Authorization header'));
  }

  const token = header.slice('Bearer '.length);
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub };
    next();
  } catch {
    next(new AuthError('Invalid or expired token'));
  }
}
