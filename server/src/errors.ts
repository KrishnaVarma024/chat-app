import type { NextFunction, Request, Response } from 'express';
import { logger } from './observability/logger';

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

/** Thrown by the token-bucket rate limiter (see rateLimit/) when a caller
 * has exhausted their bucket. `retryAfterSeconds` is surfaced as a header
 * by errorHandler below, per RFC 9110 §10.2.3 — clients (and well-behaved
 * scripts hammering this API) are supposed to honor it before retrying. */
export class RateLimitError extends AppError {
  constructor(
    public retryAfterSeconds: number,
    message = 'Too many requests'
  ) {
    super(429, 'RATE_LIMITED', message);
  }
}

// body-parser (bundled with Express via express.json()) throws a plain
// SyntaxError — not one of our AppError subclasses — when the request body
// isn't valid JSON, and stamps it with .status/.statusCode 400 and a
// .type of 'entity.parse.failed'. Left unhandled, this used to fall through
// to the generic "anything not an AppError is a 500" branch below, which is
// exactly backwards: a client sending garbage JSON is a 400 (their
// mistake), never a 500 (implying WE broke). Checked structurally
// (instanceof SyntaxError + the .type tag body-parser attaches) rather than
// importing body-parser's own error class, since Express re-exports it
// under a few different paths depending on version and we only care about
// this one specific, well-documented shape.
function isBodyParserSyntaxError(err: unknown): err is SyntaxError & { type?: string; status?: number } {
  return err instanceof SyntaxError && (err as { type?: string }).type === 'entity.parse.failed';
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (isBodyParserSyntaxError(err)) {
    logger.warn('malformed request body', { requestId: req.id, path: req.path });
    return res
      .status(400)
      .json({ error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' } });
  }

  if (err instanceof RateLimitError) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
  }

  if (err instanceof AppError) {
    // 4xx errors are expected, routine traffic (bad input, wrong password,
    // not a member of that room) — logged at 'warn', not 'error', so error-
    // level alerting stays reserved for the 500 branch below, where
    // something has actually gone wrong on our end.
    logger.warn(err.message, { requestId: req.id, code: err.code, path: req.path });
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
  }

  // Anything else is unexpected — log the real error server-side (with the
  // same request id every other log line for this request used, so it's
  // findable), but never leak internals (stack traces, DB error text) to
  // the client.
  logger.error(err instanceof Error ? err.message : 'Unknown error', {
    requestId: req.id,
    path: req.path,
    stack: err instanceof Error ? err.stack : undefined,
  });
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
