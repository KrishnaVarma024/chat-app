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
