import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../auth/auth.middleware';
import { findRoomById, isRoomMember } from '../db/rooms.repo';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';

export interface RoomScopedRequest extends AuthedRequest {
  roomId?: number;
}

// Express 5 types a route param as string | string[] (some route patterns
// can capture repeated segments) — a plain /:roomId never actually produces
// an array, but the type doesn't know that, so we reject it explicitly
// rather than silently coercing an array to a garbage number.
export function parseRoomId(raw: string | string[] | undefined): number {
  if (typeof raw !== 'string') {
    throw new ValidationError('Invalid room id');
  }
  const roomId = Number(raw);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    throw new ValidationError('Invalid room id');
  }
  return roomId;
}

/**
 * Gates any /rooms/:roomId/* route behind membership. Must run after
 * requireAuth (needs req.user). Two distinct failure modes on purpose:
 *  - room doesn't exist at all -> 404
 *  - room exists, caller just isn't in it -> 403
 * Collapsing these into one response would either leak nothing useful
 * (bad UX for "join by ID") or leak too much for a use case that actually
 * needs privacy — for this app, a room's mere existence isn't a secret,
 * only its contents are, so 403 for "not a member" is the right call here.
 */
export async function requireRoomMembership(req: RoomScopedRequest, _res: Response, next: NextFunction) {
  try {
    const roomId = parseRoomId(req.params.roomId);

    const room = await findRoomById(roomId);
    if (!room) {
      throw new NotFoundError('Room not found');
    }

    const member = await isRoomMember(roomId, req.user!.id);
    if (!member) {
      throw new ForbiddenError('You are not a member of this room');
    }

    req.roomId = roomId;
    next();
  } catch (err) {
    next(err);
  }
}
