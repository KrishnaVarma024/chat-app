import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// Augments Express's Request type globally so every route/middleware in the
// app can read req.id without importing a custom type — same pattern as
// AuthedRequest.user, just global instead of opt-in, because unlike "am I
// logged in", "what request is this" is true for literally every request.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
// A real deployment sits behind a load balancer / API gateway that may
// already stamp an id for cross-service tracing — if the caller supplied
// one, keep using it so a single request keeps the same id across every
// hop, instead of each service in the chain minting its own and breaking
// the trace. Only fall back to generating one if nothing came in, and
// bound the accepted length so a client can't smuggle an arbitrarily large
// header value into every downstream log line.
function isUsableIncomingId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * Must be the FIRST middleware registered (see app.ts) — every other
 * middleware and route handler, and critically the error handler, needs
 * req.id to already exist. Also echoes the id back as a response header so
 * a user reporting "it broke" can hand you the exact id to grep your logs
 * for, without you having to ask them to reproduce it.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(REQUEST_ID_HEADER);
  req.id = isUsableIncomingId(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
