import type { Socket } from 'socket.io-client';

/**
 * A durable, ordered "send this eventually" queue — the client-side half
 * of what's usually called the transactional outbox pattern: don't try to
 * guarantee delivery by making a single send attempt more reliable, make
 * the INTENT to send durable, and reconcile it against confirmations
 * whenever they arrive. See ARCHITECTURE_V2.md §6.
 *
 * Deliberately has ZERO dependency on socket.ts (no import of connectSocket
 * or getSocket) — flushQueueOverSocket takes a Socket as a parameter
 * instead. This avoids a circular import (socket.ts needs this module to
 * wire its listeners; if this module also imported socket.ts to fetch the
 * socket itself, each module's load would depend on the other's), and it
 * keeps this module honest as a pure "queue of intent" — it has no opinion
 * about which socket, or how many, ever flush it.
 */

export interface QueuedMessage {
  roomId: number;
  clientMessageId: string;
  body: string;
  queuedAt: string;
}

const STORAGE_KEY = 'chatapp:outbox:v1';

// Every persistence call is wrapped — localStorage can throw (quota
// exceeded, private/incognito mode in some browsers, disabled entirely by
// a user's settings). None of those are reasons the in-memory queue itself
// should stop working; losing the "survives a reload" guarantee in that
// edge case is an acceptable degradation, silently failing the whole send
// path is not.
function loadQueue(): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistQueue(next: QueuedMessage[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort. The in-memory `queue` array below is still correct for
    // the rest of this page's lifetime either way.
  }
}

// Module-level, same singleton reasoning as socket.ts and tokenStore.ts —
// hydrated once from whatever localStorage held at load time, so a queued
// message survives a full page reload while the user was offline.
let queue: QueuedMessage[] = loadQueue();

export function enqueueMessage(roomId: number, body: string, clientMessageId: string): void {
  queue.push({ roomId, body, clientMessageId, queuedAt: new Date().toISOString() });
  persistQueue(queue);
}

/**
 * Called once a message's fate is known — confirmed (message_ack) or
 * definitively rejected (a non-retryable error, e.g. FORBIDDEN or
 * VALIDATION_ERROR naming this clientMessageId). Either way, retrying it
 * further is pointless: a confirmed message doesn't need resending, and a
 * rejected one will fail identically every time, since nothing about the
 * request itself changes between attempts.
 */
export function removeFromQueue(clientMessageId: string): void {
  const next = queue.filter((m) => m.clientMessageId !== clientMessageId);
  if (next.length !== queue.length) {
    queue = next;
    persistQueue(queue);
  }
}

export function isQueued(clientMessageId: string): boolean {
  return queue.some((m) => m.clientMessageId === clientMessageId);
}

export function getQueueSnapshot(): readonly QueuedMessage[] {
  return queue;
}

/** Test-only escape hatch — production code never needs to reset this;
 * a fresh page load is the only "reset" that happens for real. */
export function __resetOutboxForTests(): void {
  queue = [];
  persistQueue(queue);
}

/**
 * Replays every still-unconfirmed message, IN ORDER, over the given
 * socket — a no-op if it isn't currently connected. Called from two
 * places in socket.ts: right after a message is newly enqueued (the
 * common case — socket already connected, this is what makes sending
 * feel instant), and on every 'connect' event, including every automatic
 * reconnect (the case this phase actually exists for).
 *
 * Deliberately does NOT track "already emitted, awaiting ack" separately
 * from "never attempted" — every call just re-emits everything still in
 * the queue, unconditionally. A message already in flight when this runs
 * again (e.g. 'connect' fires again quickly, or a send and a reconnect
 * overlap) gets emitted a second time — and that's fine BY DESIGN, not
 * despite it: the server's (room_id, sender_id, client_message_id) unique
 * constraint (messages.repo.ts, Phase 4) makes any number of duplicate
 * send_message emits for the same clientMessageId collapse to exactly one
 * row, with every one of them getting back the same message_ack. Adding
 * client-side "don't resend what's already in flight" bookkeeping would
 * be complexity in service of avoiding a redundant network round trip,
 * not in service of correctness — correctness already comes from the
 * database, for free.
 */
export function flushQueueOverSocket(socket: Socket): void {
  if (!socket.connected) return;
  // Snapshot before iterating: a message_ack for an earlier item in this
  // same batch can arrive synchronously-ish (same microtask turn, in a
  // fast local test) and call removeFromQueue, which would mutate `queue`
  // out from under a live for-of otherwise.
  for (const msg of [...queue]) {
    socket.emit('send_message', { roomId: msg.roomId, body: msg.body, clientMessageId: msg.clientMessageId });
  }
}
