/**
 * The client's "how much of this room do I already have?" bookkeeping —
 * ARCHITECTURE_V2.md §7. Extracted from ChatRoomPage (Phase 16) because it is
 * the single piece of client logic whose bugs lose messages silently, and
 * logic like that deserves to be a plain class with plain tests instead of a
 * tangle of refs inside a component.
 *
 * THE INVARIANT: every message with sequence_number <= `value` is already
 * known to this client. That is what makes `value` safe to send as
 * `sinceSequence` on a reconnect: the server returns everything above it.
 *
 * Two kinds of input try to move the cursor, and they are NOT equally safe:
 *
 *   - A catch_up page covers a contiguous range ending at its own
 *     `latestSequenceNumber`. Advancing to that is always valid.
 *   - A live push (new_message) or the ack of our own send tells us about
 *     ONE message, which may be far ahead of what we have. Advancing to it
 *     while a multi-page catch-up is still in progress would declare the
 *     whole range in between "known" — and the next page request (or the
 *     next reconnect) would skip it forever. So live inputs advance the
 *     cursor only when no catch-up is in flight.
 *
 * Follow-up pages likewise use the previous PAGE's end, never the cursor's
 * overall high-water mark, for the same reason.
 */

export interface CatchUpBatch {
  roomId: number;
  messages: Array<{ sequence_number: number }>;
  hasMore: boolean;
  latestSequenceNumber: number;
}

export class CatchUpCursor {
  private cursor: number | null;
  private chainInFlight = false;

  /** `initial` is the latest sequence from the first HTTP page, or null for a room with no history loaded yet. */
  constructor(initial: number | null = null) {
    this.cursor = initial;
  }

  /** The value to treat as "everything up to here is known", or null if nothing is. */
  get value(): number | null {
    return this.cursor;
  }

  /** True between asking for a catch-up and receiving its last page. */
  get catchingUp(): boolean {
    return this.chainInFlight;
  }

  /** Seed/raise the cursor from a source that is contiguous by construction (the initial HTTP page). */
  seed(sequence: number): void {
    this.cursor = Math.max(this.cursor ?? 0, sequence);
  }

  /**
   * Call right before emitting `join_room` for a (re)connect. Returns the
   * `sinceSequence` to send (undefined = a first-ever join with no history,
   * so no catch-up is requested and none is in flight).
   */
  beginJoin(): number | undefined {
    if (this.cursor === null) return undefined;
    this.chainInFlight = true;
    return this.cursor;
  }

  /**
   * Call for every `catch_up` batch of this room. Returns the cursor for the
   * follow-up page request, or null when the chain is complete.
   */
  onCatchUp(batch: CatchUpBatch): number | null {
    this.cursor = Math.max(this.cursor ?? 0, batch.latestSequenceNumber);
    if (batch.hasMore) {
      this.chainInFlight = true;
      return batch.latestSequenceNumber;
    }
    this.chainInFlight = false;
    return null;
  }

  /** A live `new_message` for this room, or the ack of our own send. */
  onLive(sequence: number): void {
    if (this.chainInFlight) return;
    this.cursor = Math.max(this.cursor ?? 0, sequence);
  }

  /** The connection died; whatever catch-up was in flight died with it. The cursor itself is still valid (it was never advanced past the unfinished range). */
  onDisconnect(): void {
    this.chainInFlight = false;
  }
}
