import { describe, it, expect } from 'vitest';
import { CatchUpCursor, type CatchUpBatch } from './catchUpCursor';

const batch = (latest: number, hasMore: boolean, n = 1): CatchUpBatch => ({
  roomId: 1,
  messages: Array.from({ length: n }, (_, i) => ({ sequence_number: latest - n + 1 + i })),
  hasMore,
  latestSequenceNumber: latest,
});

describe('CatchUpCursor', () => {
  it('a room with no history asks for no catch-up, so live pushes advance the cursor immediately', () => {
    const c = new CatchUpCursor(null);
    expect(c.beginJoin()).toBeUndefined();
    expect(c.catchingUp).toBe(false);
    c.onLive(1);
    c.onLive(2);
    expect(c.value).toBe(2);
  });

  it('join sends the cursor as sinceSequence and marks a catch-up in flight', () => {
    const c = new CatchUpCursor(40);
    expect(c.beginJoin()).toBe(40);
    expect(c.catchingUp).toBe(true);
  });

  it('a final page advances the cursor to ITS end and ends the chain', () => {
    const c = new CatchUpCursor(40);
    c.beginJoin();
    expect(c.onCatchUp(batch(45, false, 5))).toBeNull();
    expect(c.value).toBe(45);
    expect(c.catchingUp).toBe(false);
  });

  it('an empty "you are caught up" batch (latest = the cursor we sent) is a clean no-op', () => {
    const c = new CatchUpCursor(40);
    c.beginJoin();
    expect(c.onCatchUp(batch(40, false, 0))).toBeNull();
    expect(c.value).toBe(40);
  });

  it('follow-up pages continue from the PREVIOUS PAGE\'s end, even if a live push already jumped far ahead', () => {
    const c = new CatchUpCursor(0);
    c.beginJoin();
    c.onLive(121); // arrives before page 1 (the server joins the room before querying)
    expect(c.value).toBe(0); // ...and must not move the cursor mid catch-up
    expect(c.onCatchUp(batch(50, true, 50))).toBe(50);
    expect(c.onCatchUp(batch(100, true, 50))).toBe(100); // NOT 121
    expect(c.onCatchUp(batch(121, false, 21))).toBeNull();
    expect(c.value).toBe(121);
  });

  it('live pushes advance the cursor again once the chain is complete', () => {
    const c = new CatchUpCursor(0);
    c.beginJoin();
    c.onCatchUp(batch(10, false, 10));
    c.onLive(11);
    c.onLive(12);
    expect(c.value).toBe(12);
  });

  it('own-message acks follow the same rule as live pushes', () => {
    const c = new CatchUpCursor(5);
    c.beginJoin();
    c.onLive(99); // an ack mid-chain
    expect(c.value).toBe(5);
  });

  it('a disconnect mid-chain leaves the cursor at the last contiguous point, so the reconnect refetches the unfinished range', () => {
    const c = new CatchUpCursor(0);
    c.beginJoin();
    c.onLive(121); // would have declared 1..121 "known" if it were allowed to
    c.onCatchUp(batch(50, true, 50));
    c.onDisconnect(); // dropped before pages 2 and 3
    expect(c.catchingUp).toBe(false);
    expect(c.beginJoin()).toBe(50); // NOT 121: 51..120 are still owed
  });

  it('the cursor never moves backwards', () => {
    const c = new CatchUpCursor(100);
    c.seed(90);
    expect(c.value).toBe(100);
    c.beginJoin();
    c.onCatchUp(batch(80, false, 1));
    expect(c.value).toBe(100);
  });

  describe('contiguity watermark (live pushes can overtake each other)', () => {
    it('a live push beyond a hole does not move the cursor; filling the hole releases everything waiting above it', () => {
      const c = new CatchUpCursor(0);
      c.onLive(2); // seq 2 overtook seq 1
      expect(c.value).toBe(0);
      expect(c.hasGap).toBe(true);
      c.onLive(3);
      expect(c.value).toBe(0);
      c.onLive(1); // the late one arrives
      expect(c.value).toBe(3);
      expect(c.hasGap).toBe(false);
    });

    it('a disconnect while a hole is open reconnects from the WATERMARK, so the missing message is refetched', () => {
      const c = new CatchUpCursor(0);
      c.onLive(2);
      c.onDisconnect();
      expect(c.beginJoin()).toBe(0); // NOT 2
    });

    it('a catch_up page that spans the hole is authoritative: it jumps the watermark and absorbs what was waiting', () => {
      const c = new CatchUpCursor(0);
      c.beginJoin();
      c.onLive(2);
      expect(c.onCatchUp(batch(2, false, 2))).toBeNull();
      expect(c.value).toBe(2);
      expect(c.hasGap).toBe(false);
    });

    it('a burned sequence number leaves a permanent hole: the watermark holds, the next catch_up steps over it', () => {
      const c = new CatchUpCursor(4);
      c.onLive(6); // 5 was burned by a duplicate retry - it will never arrive
      c.onLive(7);
      expect(c.value).toBe(4); // conservative, never wrong
      c.beginJoin();
      c.onCatchUp(batch(7, false, 2)); // the server says: nothing between 4 and 6 exists
      expect(c.value).toBe(7);
    });
  });
});
