import type { Server } from 'socket.io';
import { listRoomsForUser } from '../db/rooms.repo';
import { env } from '../config/env';
import { logger } from '../observability/logger';
import { roomKey } from './rooms.socket';

/**
 * Reference-counted presence, per ARCHITECTURE_V2.md §9. Keyed by userId,
 * not socketId — "online" is a property of a PERSON, and a person can have
 * more than one socket open at once (two tabs, a phone and a laptop). A
 * naive "this socket disconnected -> broadcast offline" model would flicker
 * a still-present user to "offline" the instant any ONE of their sockets
 * closes, which is wrong the moment anyone has two tabs open.
 *
 * Module-level state, not per-connection — this map has to outlive any
 * single socket, and there is exactly one of it for the whole process (see
 * the per-process caveat in ARCHITECTURE_V2.md §9/§12: this does not survive
 * a restart and does not span multiple instances; both are explicitly
 * deferred, not accidentally forgotten).
 */
const socketsByUser = new Map<number, Set<string>>();

/**
 * A user whose LAST socket just disconnected doesn't immediately get
 * broadcast offline — see markOffline below. This tracks the in-flight
 * grace-period timers so a reconnect within the window can cancel one
 * before it fires. Keyed by userId (at most one pending "are they really
 * gone" timer per user at any moment — markOnline always clears it first).
 */
const pendingOfflineTimers = new Map<number, NodeJS.Timeout>();

async function broadcastPresence(io: Server, userId: number, status: 'online' | 'offline'): Promise<void> {
  // "Every room that user is a member of" per §9 — DB membership, not
  // Socket.IO room membership. io.to(roomKey(id)) only actually reaches
  // sockets currently joined to that room's channel (the same scoping
  // new_message/catch_up already use), which is exactly right: presence
  // only matters to people actively viewing a room together, not to a
  // member who happens to be a member but isn't looking at it right now.
  const rooms = await listRoomsForUser(userId);
  for (const room of rooms) {
    io.to(roomKey(room.id)).emit('presence', { userId, status });
  }
}

/**
 * Call once per successful connection, right after auth. Adds this socket
 * to the user's set; broadcasts 'online' ONLY if this user had zero other
 * sockets a moment ago (the reference-counting part) AND there wasn't a
 * grace-period timer already running for them (the "reconnect within the
 * window" part — see markOffline's doc comment for why that case
 * deliberately broadcasts nothing at all, not even a fresh 'online').
 */
export async function markOnline(io: Server, userId: number, socketId: string): Promise<void> {
  const pendingTimer = pendingOfflineTimers.get(userId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingOfflineTimers.delete(userId);
    // This IS the "page refresh" / brief-drop case §9 calls out by name: an
    // 'offline' was never actually broadcast for this user (the timer was
    // still pending), so there is nothing for rooms to "undo" — skip
    // broadcasting 'online' too. From everyone else's point of view,
    // nothing about this user's status ever visibly changed.
    let sockets = socketsByUser.get(userId);
    if (!sockets) {
      sockets = new Set();
      socketsByUser.set(userId, sockets);
    }
    sockets.add(socketId);
    return;
  }

  let sockets = socketsByUser.get(userId);
  const wasOffline = !sockets || sockets.size === 0;
  if (!sockets) {
    sockets = new Set();
    socketsByUser.set(userId, sockets);
  }
  sockets.add(socketId);

  if (wasOffline) {
    await broadcastPresence(io, userId, 'online');
  }
}

/**
 * Call from the SAME 'disconnect' handler regardless of what triggered it
 * (§8: an explicit close and a heartbeat-timeout-detected death run through
 * identical cleanup — there is no branch on `reason` anywhere in here).
 * Removes this one socket; if the user has other sockets left, this is a
 * silent no-op (still online, reference count just decremented). Only when
 * the LAST socket goes away does a grace-period timer start — see §9's
 * "why" in ARCHITECTURE_V2.md: broadcasting offline immediately would flash
 * every page refresh to everyone in the user's rooms.
 */
export function markOffline(io: Server, userId: number, socketId: string): void {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return; // already cleaned up somehow — nothing to do
  sockets.delete(socketId);
  if (sockets.size > 0) return; // still has other live connections

  socketsByUser.delete(userId);

  const timer = setTimeout(() => {
    pendingOfflineTimers.delete(userId);
    // Re-check rather than assume: if markOnline ran in the meantime it
    // already cleared this exact timer, so in practice this callback only
    // ever fires when the user is genuinely still gone — this check is a
    // second line of defense against any timer-ordering surprise, not the
    // primary mechanism.
    if (!socketsByUser.has(userId)) {
      broadcastPresence(io, userId, 'offline').catch((err) => {
        logger.error('failed to broadcast offline presence', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }, env.presenceGracePeriodMs);

  pendingOfflineTimers.set(userId, timer);
}

/** Small introspection utility — not currently called from any request path
 * or exercised by the verification script (that script observes presence
 * purely through the 'presence' broadcasts a real client would see, which
 * is the actual contract this feature promises). Kept because "is this
 * user currently online" is a natural query to want later (e.g. showing a
 * room's member list with live status on load — deliberately out of scope
 * for this phase, see ARCHITECTURE_V2.md §9), and it costs nothing to
 * expose now against the map that already exists. */
export function isOnline(userId: number): boolean {
  return socketsByUser.has(userId);
}
