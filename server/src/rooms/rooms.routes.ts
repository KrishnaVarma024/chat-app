import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../auth/auth.middleware';
import { requireRoomMembership, parseRoomId, type RoomScopedRequest } from './rooms.middleware';
import { encodeCursor, decodeCursor } from './cursor';
import {
  createRoom,
  findRoomById,
  listRoomsForUser,
  addRoomMember,
  removeRoomMember,
} from '../db/rooms.repo';
import {
  sendMessage,
  listMessagesAfter,
  listMessagesBefore,
  getLatestSequenceNumber,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
} from '../db/messages.repo';
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

const sendMessageSchema = z.object({
  body: z.string().min(1).max(4000),
  // Client-generated — this is the idempotency key, see messages.repo.ts.
  clientMessageId: z.string().uuid(),
});

roomsRouter.post(
  '/:roomId/messages',
  requireRoomMembership,
  async (req: RoomScopedRequest, res, next) => {
    try {
      const parsed = sendMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');
      }

      const message = await sendMessage({
        roomId: req.roomId!,
        senderId: req.user!.id,
        clientMessageId: parsed.data.clientMessageId,
        body: parsed.data.body,
      });

      // Always 201, whether this call created the message or just confirmed
      // an already-sent one — the client shouldn't have to branch on status
      // code to know "my message exists now," which is true either way.
      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  }
);

const listMessagesQuerySchema = z
  .object({
    after: z.string().min(1).optional(),
    before: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  })
  .refine((data) => !(data.after && data.before), {
    message: 'Cannot specify both after and before in the same request',
  });

/**
 * GET /rooms/:roomId/messages?after=<cursor>   -> poll (live sync)
 * GET /rooms/:roomId/messages?before=<cursor>  -> scrollback (history)
 * GET /rooms/:roomId/messages                  -> initial load (latest page)
 *
 * Poll and scrollback are the same keyset-pagination primitive pointed in
 * opposite directions (ARCHITECTURE.md §7) — this handler's only job is to
 * pick a direction, decode that direction's cursor, and hand off to the
 * matching repo function. Never OFFSET, never a page number.
 */
roomsRouter.get(
  '/:roomId/messages',
  requireRoomMembership,
  async (req: RoomScopedRequest, res, next) => {
    try {
      const parsed = listMessagesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query parameters');
      }
      const { after, before, limit } = parsed.data;
      const effectiveLimit = limit ?? DEFAULT_PAGE_LIMIT;
      const roomId = req.roomId!;

      let messages;
      let hasMore: boolean;
      let nextCursor: string | null;

      if (after !== undefined) {
        const afterSeq = decodeCursor(after);
        const result = await listMessagesAfter(roomId, afterSeq, effectiveLimit);
        messages = result.messages;
        hasMore = result.hasMore;
        // Nothing new since the caller's cursor: hand the same cursor back
        // rather than encoding one from an empty batch.
        nextCursor = messages.length > 0
          ? encodeCursor(messages[messages.length - 1].sequence_number)
          : after;
      } else {
        const beforeSeq = before !== undefined ? decodeCursor(before) : null;
        const result = await listMessagesBefore(roomId, beforeSeq, effectiveLimit);
        messages = result.messages;
        hasMore = result.hasMore;
        nextCursor = messages.length > 0
          ? encodeCursor(messages[0].sequence_number)
          : (before ?? null);
      }

      const latestSequenceNumber = await getLatestSequenceNumber(roomId);

      res.json({
        messages,
        latest_sequence_number: latestSequenceNumber,
        has_more: hasMore,
        next_cursor: nextCursor,
      });
    } catch (err) {
      next(err);
    }
  }
);
