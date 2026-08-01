import type { NextFunction, Request, Response } from 'express';

/**
 * Base class for errors we deliberately throw and want mapped to a specific
 * HTTP status + stable error code. Anything that isn't an AppError is
 * treated as a bug and mapped to a generic 500 (see errorHandler below).
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

/** "I know who you are, but you're not allowed to do this" — distinct from
 * AuthError (401, "I don't know who you are"). Phase 1/2 never needed this
 * because every protected route only ever asked "are you logged in", never
 * "are you allowed to touch this specific resource." Room membership is the
 * first place that second question shows up. */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
  }
  // Anything else is unexpected — log the real error server-side, but never
  // leak internals (stack traces, DB error text) to the client.
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
