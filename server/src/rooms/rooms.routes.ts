import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../auth/auth.middleware';
import { requireRoomMembership, parseRoomId, type RoomScopedRequest } from './rooms.middleware';
import {
  createRoom,
  findRoomById,
  listRoomsForUser,
  addRoomMember,
  removeRoomMember,
} from '../db/rooms.repo';
import { ValidationError, NotFoundError } from '../errors';

export const roomsRouter = Router();

// Every route under /rooms requires a logged-in user — there is no
// anonymous or public access to any of this.
roomsRouter.use(requireAuth);

const createRoomSchema = z.object({
  name: z.string().min(1).max(100),
});

roomsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const room = await createRoom(parsed.data.name, req.user!.id);
    res.status(201).json(room);
  } catch (err) {
    next(err);
  }
});

roomsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const rooms = await listRoomsForUser(req.user!.id);
    res.json(rooms);
  } catch (err) {
    next(err);
  }
});

roomsRouter.get('/:roomId', requireRoomMembership, async (req: RoomScopedRequest, res, next) => {
  try {
    const room = await findRoomById(req.roomId!);
    res.json(room);
  } catch (err) {
    next(err);
  }
});

// Deliberately NOT behind requireRoomMembership — joining is the action
// that grants membership, so it can't require membership as a precondition.
// It still needs its own "does this room exist" check, since joining a
// room that was never created shouldn't silently create a dangling row.
roomsRouter.post('/:roomId/join', async (req: AuthedRequest, res, next) => {
  try {
    const roomId = parseRoomId(req.params.roomId);
    const room = await findRoomById(roomId);
    if (!room) {
      throw new NotFoundError('Room not found');
    }
    await addRoomMember(roomId, req.user!.id, 'member');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

roomsRouter.post('/:roomId/leave', requireRoomMembership, async (req: RoomScopedRequest, res, next) => {
  try {
    await removeRoomMember(req.roomId!, req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
