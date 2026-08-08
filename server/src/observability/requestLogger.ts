import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger';

/**
 * One log line when a request comes in, one more when it finishes — both
 * carrying the same req.id (see requestId.ts), so grepping/filtering logs
 * by that id gives you the complete story of one request: what it was,
 * what it returned, and how long it took. This is the actual "request-id
 * propagation" Phase 7 asks for — not a single log line, but every log
 * line touched by a request being tagged with the same value, including
 * error logs (see errors.ts's errorHandler, which logs with req.id too).
 *
 * Listening on res.on('finish') rather than logging after next() returns
 * is deliberate: next() returns as soon as the synchronous part of the
 * route handler yields control (e.g. hits an `await`), long before the
 * response is actually sent — 'finish' is the only event that's actually
 * true when it fires.
 *
 * req.method/req.path are captured HERE, up front, and reused in the
 * 'finish' line rather than re-read from req inside the callback — this
 * is fixing a real bug caught by actually running this against the
 * server, not a defensive-programming guess. Express's nested routers
 * (roomsRouter is mounted at app.use('/rooms', roomsRouter)) temporarily
 * strip the mount prefix from req.url while inside that router, and only
 * restore it via the wrapped `next` callback each layer received — which
 * means a route handler that ends the response directly (res.json(...))
 * *without* calling next() again never triggers that restoration. Reading
 * req.path lazily inside 'finish' therefore returned "/2/messages"
 * instead of "/rooms/2/messages" for every successful request (verified
 * in scripts/hardening-test.mjs's log output — the 429 rate-limit
 * rejections, which DO propagate via next(err) through every layer, showed
 * the correct full path; the 200s didn't). Capturing the value before
 * Express's routing has a chance to mutate it sidesteps the whole issue.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();
  const { method, path } = req;

  logger.info('request received', { requestId: req.id, method, path });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info('request completed', {
      requestId: req.id,
      method,
      path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
}
