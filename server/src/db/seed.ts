import { pool } from './pool';

/**
 * Dev-only seed data: two users, one shared room. Safe to re-run —
 * every insert is written to no-op (via ON CONFLICT) instead of erroring
 * or duplicating on a second run.
 */
async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const users = await client.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ('alice', 'alice@example.com', 'dev-only-not-a-real-hash'),
              ('bob', 'bob@example.com', 'dev-only-not-a-real-hash')
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id, username`
    );

    const alice = users.rows.find((u) => u.username === 'alice');
    const bob = users.rows.find((u) => u.username === 'bob');

    const room = await client.query(
      `INSERT INTO rooms (name, created_by)
       VALUES ('general', $1)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [alice.id]
    );

    // If the room already existed from a previous seed run, ON CONFLICT DO
    // NOTHING returns no row — look it up instead of assuming row.length > 0.
    const roomId =
      room.rows[0]?.id ??
      (
        await client.query(`SELECT id FROM rooms WHERE name = 'general' AND created_by = $1`, [
          alice.id,
        ])
      ).rows[0].id;

    await client.query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [roomId, alice.id, bob.id]
    );

    await client.query(
      `INSERT INTO room_sequence_counters (room_id, last_sequence)
       VALUES ($1, 0)
       ON CONFLICT (room_id) DO NOTHING`,
      [roomId]
    );

    await client.query('COMMIT');
    console.log(`Seeded: users=[alice#${alice.id}, bob#${bob.id}], room=general#${roomId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
