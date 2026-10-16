import type { Server } from 'socket.io';
import { pool } from '../db/pool';
import { logger } from '../observability/logger';
import type { MembershipRevoked } from './membershipEvents';
import type { AuthedSocketData } from './socketAuth.middleware';

/**
 * LEVEL-TRIGGERED backstop for the EDGE-TRIGGERED eviction in membershipEvents.ts.
 *
 * The announce -> evict path is an edge: it fires once, at the moment a leave
 * happens, and if that one signal is lost (an exception between the DELETE and
 * the announce, a crash on another instance, a bus that does not span
 * processes) nothing ever repeats it - the zombie stays until its connection
 * happens to drop. A reconciliation loop does not depend on having seen the
 * edge: every `intervalMs` it asks the only question that matters - "which
 * (room, user) pairs are live in memory but not in room_members?" - and evicts
 * those. Staleness is bounded by `intervalMs`, whatever went wrong.
 *
 * Cost: ONE query per tick for the whole server (not per room, not per push):
 * it joins the live (room, user) pairs against room_members and returns only
 * the violators. With the Redis adapter `fetchSockets()` is cluster-wide, so
 * any one instance's sweep covers everyone; duplicate evictions are harmless
 * (socketsLeave is idempotent).
 */
export function startMembershipSweep(
  io: Server,
  evict: (event: MembershipRevoked) => void,
  intervalMs: number
): () => void {
  if (intervalMs <= 0) return () => undefined;
  let running = false; // never overlap ticks: a slow DB must not stack up queries

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const pairs = new Set<string>();
      const roomIds: number[] = [];
      const userIds: number[] = [];
      for (const s of await io.fetchSockets()) {
        const userId = (s.data as AuthedSocketData).userId;
        for (const r of s.rooms) {
          if (!r.startsWith('room:')) continue;
          const roomId = Number(r.slice('room:'.length));
          const key = `${roomId}:${userId}`;
          if (pairs.has(key)) continue;
          pairs.add(key);
          roomIds.push(roomId);
          userIds.push(userId);
        }
      }
      if (roomIds.length === 0) return;

      const { rows } = await pool.query<{ room_id: number; user_id: number }>(
        `SELECT p.room_id, p.user_id
           FROM unnest($1::bigint[], $2::bigint[]) AS p(room_id, user_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM room_members m WHERE m.room_id = p.room_id AND m.user_id = p.user_id
          )`,
        [roomIds, userIds]
      );
      for (const row of rows) {
        // A hit means the fast path FAILED for this pair. Worth a warn (and, in a real
        // system, a counter to alert on): the sweep is the safety net, not the plan.
        logger.warn('membership sweep evicting a zombie socket', { roomId: row.room_id, userId: row.user_id });
        evict({ roomId: Number(row.room_id), userId: Number(row.user_id) });
      }
    } catch (err) {
      // A failed tick is retried by the next one; it must never take the process down.
      logger.error('membership sweep failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
