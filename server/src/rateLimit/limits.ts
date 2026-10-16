import { createBucketStore } from './bucketStore';

/**
 * Every rate-limited thing in the app, in one place, as a SHARED store per
 * thing — not per transport. See bucketStore.ts for why: the HTTP route and
 * the socket handler for "send a message" must spend from the same budget,
 * or a client gets double the rate by alternating transports.
 *
 * Numbers are carried over unchanged from the Phase 7 limiters (and Phase
 * 14's typing bucket) — Phase 15 moves WHERE they live and WHO can spend
 * them, not how generous they are.
 */

// Burst of 10 messages, then 2/sec. Human typing speed already throttles
// sends naturally; this exists for scripted floods.
export const sendMessageStore = createBucketStore({ capacity: 10, refillPerSecond: 2 });

// HTTP-only (there is no socket equivalent of polling). Sized against the
// client's own polling behavior (usePolling.ts) with headroom for a few
// open tabs — kept separate from sends so a user who is merely READING
// can never be throttled out of SENDING.
export const pollMessagesStore = createBucketStore({ capacity: 20, refillPerSecond: 5 });

// Socket-only. Deliberately generous relative to the client's own ~2s
// typing throttle (MessageInput.tsx): normal use never gets near it, a
// client ignoring its own throttle gets capped after one burst.
export const typingStore = createBucketStore({ capacity: 10, refillPerSecond: 2 });
