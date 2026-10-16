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
 * `value` is therefore a CONTIGUITY WATERMARK, not "the newest thing I have
 * seen". The two are different the moment anything arrives out of order:
 *
 *   - A catch_up page is the one input that may JUMP the watermark. The
 *     server's SELECT (sequence_number > since, ordered, limited) is an
 *     authoritative statement about the whole range (since, latest], so
 *     advancing to `latestSequenceNumber` is always valid.
 *   - A live push (new_message) or the ack of our own send tells us about ONE
 *     message. It moves the watermark only if it is exactly watermark+1 (or
 *     if it completes a run that was waiting). Anything further ahead is kept
 *     in `ahead` - the message is still SHOWN, `ahead` only decides what the
 *     cursor may CLAIM - and is released when the hole below it fills in or a
 *     catch_up page covers it.
 *
 * Why not "advance to the newest, but not while a catch-up is in flight"
 * (what Phase 16 first shipped)? That guard fixes live pushes racing a
 * multi-page catch-up, but not live pushes racing EACH OTHER: two senders'
 * handlers can resume in the opposite order to their commits, so seq 2 can be
 * pushed before seq 1 with no catch-up anywhere. Jumping to 2 declares 1
 * known; a disconnect before 1's push lands then loses it for good (the
 * reconnect asks for "> 2"). The watermark removes the whole class: there is
 * no "unsafe input" to guard against, because no input except an
 * authoritative page can move the cursor past a hole.
 *
 * A hole that never fills (a sequence number burned by a duplicate retry -
 * messages.repo.ts) is harmless: the watermark stalls below it, which is the
 * conservative direction. The next catch_up (any reconnect) steps over it.
 * `hasGap` exposes "a live message is waiting above a hole" so a page can
 * schedule a repair join_room if it wants a tighter bound.
 *
 * Follow-up pages continue from the previous PAGE's end. Because the
 * watermark is contiguous, continuing from the watermark itself would be
 * equally correct (and skip whatever live pushes already filled in) - the two
 * are interchangeable, which the model test confirms by mutation.
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
  /** Live sequences above cursor+1: received, but with a hole below them. */
  private readonly ahead = new Set<number>();

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
    this.raiseTo(sequence);
  }

  /** True while a live message has arrived beyond a hole: something below it is missing or still in flight. A page can use this to schedule a repair join_room. */
  get hasGap(): boolean {
    return this.ahead.size > 0;
  }

  /** Authoritative advance (seed / catch_up page): jump, forget what the jump covers, then absorb any live sequences that are now contiguous. */
  private raiseTo(sequence: number): void {
    this.cursor = Math.max(this.cursor ?? 0, sequence);
    this.drain();
  }

  private drain(): void {
    let c = this.cursor ?? 0;
    for (const s of this.ahead) if (s <= c) this.ahead.delete(s);
    while (this.ahead.delete(c + 1)) c++;
    if (c > 0 || this.cursor !== null) this.cursor = c;
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
    this.raiseTo(batch.latestSequenceNumber);
    if (batch.hasMore) {
      this.chainInFlight = true;
      return batch.latestSequenceNumber;
    }
    this.chainInFlight = false;
    return null;
  }

  /** A live `new_message` for this room, or the ack of our own send. */
  onLive(sequence: number): void {
    if (sequence <= (this.cursor ?? 0)) return; // already covered
    this.ahead.add(sequence); // remember it; it only moves the cursor once nothing below it is missing
    this.drain();
  }

  /** The connection died; whatever catch-up was in flight died with it. The cursor itself is still valid (it was never advanced past the unfinished range). */
  onDisconnect(): void {
    this.chainInFlight = false;
    this.ahead.clear(); // the reconnect's catch-up refetches everything above the cursor anyway
  }
}
