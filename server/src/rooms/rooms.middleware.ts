import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../auth/auth.middleware';
import { findRoomById, isRoomMember, type RoomRow } from '../db/rooms.repo';
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
 * The actual authorization check, extracted so it has exactly ONE
 * implementation regardless of which transport is asking. Both the Express
 * middleware below (HTTP routes) and the Socket.IO join_room handler
 * (realtime/rooms.socket.ts, Phase 9) call this same function — a room's
 * membership rules can't quietly drift apart between the two transports,
 * because there's only one place they're written down.
 *
 * Two distinct failure modes on purpose:
 *  - room doesn't exist at all -> NotFoundError (404 / NOT_FOUND)
 *  - room exists, caller just isn't in it -> ForbiddenError (403 / FORBIDDEN)
 * Collapsing these into one response would either leak nothing useful
 * (bad UX for "join by ID") or leak too much for a use case that actually
 * needs privacy — for this app, a room's mere existence isn't a secret,
 * only its contents are, so a distinct "not a member" response is the
 * right call here.
 */
export async function checkRoomMembership(roomId: number, userId: number): Promise<RoomRow> {
  const room = await findRoomById(roomId);
  if (!room) {
    throw new NotFoundError('Room not found');
  }

  const member = await isRoomMember(roomId, userId);
  if (!member) {
    throw new ForbiddenError('You are not a member of this room');
  }

  return room;
}

/**
 * Gates any /rooms/:roomId/* route behind membership. Must run after
 * requireAuth (needs req.user). Thin wrapper around checkRoomMembership —
 * see that function's doc comment for why the check itself lives there,
 * not here.
 */
export async function requireRoomMembership(req: RoomScopedRequest, _res: Response, next: NextFunction) {
  try {
    const roomId = parseRoomId(req.params.roomId);
    await checkRoomMembership(roomId, req.user!.id);
    req.roomId = roomId;
    next();
  } catch (err) {
    next(err);
  }
}
