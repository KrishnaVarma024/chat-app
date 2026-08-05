import { pool } from './pool';

export interface MessageRow {
  id: number;
  room_id: number;
  sender_id: number;
  sequence_number: number;
  client_message_id: string;
  body: string;
  created_at: Date;
}

/**
 * Sends a message with a gap-free, per-room sequence number, atomically,
 * and de-duplicates retries by client_message_id. See ARCHITECTURE.md §6.
 *
 * A deliberate trade-off lives in here, worth being explicit about: if this
 * is a *retry* of an already-sent message (same client_message_id), the
 * sequence number claimed on this call is still consumed and never attached
 * to any row — it's permanently skipped. That's fine. The guarantee this
 * app actually depends on is "no two messages ever share a sequence number,
 * and every sequence number that exists is stable and ordered" — nothing
 * anywhere relies on the raw integers being contiguous with zero skips.
 * The alternative (check-then-increment) doesn't even fully avoid this
 * under real concurrency — two truly simultaneous retries can both pass a
 * "does this exist yet" check before either commits — so it would add
 * complexity for a guarantee it can't actually deliver.
 */
export async function sendMessage(params: {
  roomId: number;
  senderId: number;
  clientMessageId: string;
  body: string;
}): Promise<MessageRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seqResult = await client.query<{ last_sequence: number }>(
      `INSERT INTO room_sequence_counters (room_id, last_sequence)
       VALUES ($1, 1)
       ON CONFLICT (room_id) DO UPDATE SET last_sequence = room_sequence_counters.last_sequence + 1
       RETURNING last_sequence`,
      [params.roomId]
    );
    const sequenceNumber = seqResult.rows[0].last_sequence;

    const insertResult = await client.query<MessageRow>(
      `INSERT INTO messages (room_id, sender_id, sequence_number, client_message_id, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id, sender_id, client_message_id) DO NOTHING
       RETURNING *`,
      [params.roomId, params.senderId, sequenceNumber, params.clientMessageId, params.body]
    );

    if (insertResult.rows.length === 0) {
      // THIS SENDER already used this client_message_id in this room — a
      // retry, not a new message. Scoped by sender_id (not just room_id)
      // so one user can never collide with another user's idempotency key.
      // Fetch and return the original instead of erroring or silently
      // creating a duplicate.
      const existing = await client.query<MessageRow>(
        `SELECT * FROM messages WHERE room_id = $1 AND sender_id = $2 AND client_message_id = $3`,
        [params.roomId, params.senderId, params.clientMessageId]
      );
      await client.query('COMMIT'); // the sequence-number claim above stands regardless
      return existing.rows[0];
    }

    await client.query('COMMIT');
    return insertResult.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export interface ListMessagesResult {
  messages: MessageRow[];
  hasMore: boolean;
}

/**
 * Poll direction: everything strictly after a cursor, oldest first — the
 * order a client wants to append new messages to a chat log. Fetches
 * limit+1 rows so `hasMore` can be answered without a second COUNT query;
 * the (limit+1)th row is only ever used to set the flag, never returned.
 * Correctness note: because sequence_number is assigned once and never
 * reused or rewritten (see sendMessage above), this WHERE clause is stable
 * under concurrent inserts — new messages only ever get sequence numbers
 * *greater* than anything already returned, so they can never retroactively
 * appear inside, or shift, a page that's already been served.
 */
export async function listMessagesAfter(
  roomId: number,
  afterSeq: number,
  limit: number = DEFAULT_PAGE_LIMIT
): Promise<ListMessagesResult> {
  const result = await pool.query<MessageRow>(
    `SELECT * FROM messages
     WHERE room_id = $1 AND sequence_number > $2
     ORDER BY sequence_number ASC
     LIMIT $3`,
    [roomId, afterSeq, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  return { messages: result.rows.slice(0, limit), hasMore };
}

/**
 * Scrollback direction: everything strictly before a cursor, returned in
 * descending order (so LIMIT keeps the *nearest* history to the cursor,
 * not the oldest messages in the whole room) then reversed back to
 * ascending for rendering. `beforeSeq === null` means "no lower bound yet"
 * — the very first page a client loads when it opens a room, which is
 * just "give me the most recent messages," i.e. scrollback with an
 * effectively infinite starting cursor.
 */
export async function listMessagesBefore(
  roomId: number,
  beforeSeq: number | null,
  limit: number = DEFAULT_PAGE_LIMIT
): Promise<ListMessagesResult> {
  const result =
    beforeSeq === null
      ? await pool.query<MessageRow>(
          `SELECT * FROM messages
           WHERE room_id = $1
           ORDER BY sequence_number DESC
           LIMIT $2`,
          [roomId, limit + 1]
        )
      : await pool.query<MessageRow>(
          `SELECT * FROM messages
           WHERE room_id = $1 AND sequence_number < $2
           ORDER BY sequence_number DESC
           LIMIT $3`,
          [roomId, beforeSeq, limit + 1]
        );

  const hasMore = result.rows.length > limit;
  const page = result.rows.slice(0, limit);
  page.reverse();
  return { messages: page, hasMore };
}

/** The room's current position, independent of pagination direction — this
 * is what lets a client tell "I've rendered everything" apart from "I hit
 * this page's limit but there's more." Reads room_sequence_counters rather
 * than MAX(messages.sequence_number): it's the same value, already
 * maintained atomically on every send, and an indexed point lookup instead
 * of a scan. Returns 0 for a room that has never had a message sent to it
 * (no counter row exists yet — see sendMessage's lazy INSERT ON CONFLICT). */
export async function getLatestSequenceNumber(roomId: number): Promise<number> {
  const result = await pool.query<{ last_sequence: number }>(
    `SELECT last_sequence FROM room_sequence_counters WHERE room_id = $1`,
    [roomId]
  );
  return result.rows[0]?.last_sequence ?? 0;
}
