import { pool } from './pool';

export interface RoomRow {
  id: number;
  name: string;
  created_by: number;
  created_at: Date;
}

export type RoomRole = 'owner' | 'member';

/** Creates the room and adds the creator as 'owner' in one transaction —
 * a room with no members, or a membership row pointing at a room that
 * failed to insert, are both states we never want visible even briefly. */
export async function createRoom(name: string, createdBy: number): Promise<RoomRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roomResult = await client.query<RoomRow>(
      `INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING *`,
      [name, createdBy]
    );
    const room = roomResult.rows[0];

    await client.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [room.id, createdBy]
    );

    await client.query('COMMIT');
    return room;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function findRoomById(id: number): Promise<RoomRow | undefined> {
  const result = await pool.query<RoomRow>('SELECT * FROM rooms WHERE id = $1', [id]);
  return result.rows[0];
}

/** Only the caller's own rooms — there is no "browse all rooms" endpoint.
 * Membership is what makes a room visible to you at all. */
export async function listRoomsForUser(userId: number): Promise<RoomRow[]> {
  const result = await pool.query<RoomRow>(
    `SELECT r.* FROM rooms r
     JOIN room_members rm ON rm.room_id = r.id
     WHERE rm.user_id = $1
     ORDER BY r.created_at DESC`,
    [userId]
  );
  return result.rows;
}

export async function isRoomMember(roomId: number, userId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Idempotent — joining a room you're already in is a no-op, not an error.
 * Same reasoning as the seed script's upsert: retrying a join (double
 * click, network retry) shouldn't be able to fail or duplicate anything. */
export async function addRoomMember(roomId: number, userId: number, role: RoomRole = 'member'): Promise<void> {
  await pool.query(
    `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [roomId, userId, role]
  );
}

export async function removeRoomMember(roomId: number, userId: number): Promise<void> {
  await pool.query(`DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
}
