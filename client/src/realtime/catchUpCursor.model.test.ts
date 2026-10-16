/**
 * Model-based test for CatchUpCursor (Phase 16 exercise M2).
 *
 * Example-based tests check the interleavings someone thought of. The bugs
 * this class exists to prevent live in the ones nobody thought of (a live push
 * landing between two catch-up pages; a drop mid-chain; two pushes swapping
 * places). So this file simulates a server and one client's network, drives
 * the REAL class with thousands of seeded-random interleavings, and checks the
 * invariant after EVERY step:
 *
 *     every message with sequence_number <= cursor.value is already known.
 *
 * plus a liveness check at the end: after a full reconnect the client holds
 * the whole log (no message is permanently lost).
 *
 * A failure prints its seed and the exact step trace, so it replays
 * deterministically. `outOfOrder` models two handlers broadcasting in the
 * opposite order to their commits; against the old "newest-seen, unless a
 * catch-up is in flight" cursor it fails within a few steps (about a third of
 * seeds), against the watermark it never does.
 */
import { describe, it, expect } from 'vitest';
import { CatchUpCursor, type CatchUpBatch } from './catchUpCursor';

/** mulberry32: a tiny seeded PRNG, so every failure is replayable from one integer. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ev = { t: 'live'; seq: number } | { t: 'batch'; batch: CatchUpBatch };
interface Config {
  pageSize: number;
  ops: number;
  burn: boolean; // sequence numbers skipped by duplicate retries (Phase 4's documented trade-off)
  outOfOrder: boolean; // live pushes may overtake each other (the §7 "known limit")
}

/** A tiny simulated server + one-client network, driving the REAL CatchUpCursor. */
function run(seed: number, cfg: Config): { violation: string | null; trace: string[] } {
  const rand = rng(seed);
  const trace: string[] = [];
  const log: number[] = []; // committed sequence numbers, ascending (burned numbers are simply absent)
  let nextSeq = 1;
  const initial = Math.floor(rand() * 8); // the first HTTP page: contiguous 1..initial
  for (let i = 0; i < initial; i++) log.push(nextSeq++);

  const known = new Set<number>(log); // what the client actually holds
  const cursor = new CatchUpCursor(initial);
  let connected = false;
  let joined = false; // server side: socket is in the live room
  let queue: Ev[] = []; // server -> client, FIFO like a socket
  let pendingQueries: number[] = []; // join_room requests the server has not yet run its SELECT for

  const check = (after: string): string | null => {
    trace.push(after);
    const c = cursor.value;
    if (c === null) return null;
    for (const s of log) if (s <= c && !known.has(s)) return `INVARIANT BROKEN after "${after}": cursor=${c} but message ${s} is unknown`;
    return null;
  };

  const ops = {
    append() {
      if (cfg.burn && rand() < 0.2) nextSeq++; // a duplicate retry burned a number
      const seq = nextSeq++;
      log.push(seq);
      if (connected && joined) queue.push({ t: 'live', seq });
      return `append ${seq}`;
    },
    disconnect() {
      if (!connected) return null;
      connected = joined = false;
      queue = [];
      pendingQueries = [];
      cursor.onDisconnect();
      return 'disconnect';
    },
    connect() {
      if (connected) return null;
      connected = true;
      joined = true; // server joins the live room FIRST (the Phase 16 fix)...
      const since = cursor.beginJoin();
      if (since !== undefined) pendingQueries.push(since); // ...and runs the catch-up SELECT later
      return `connect since=${since}`;
    },
    serverQuery() {
      if (!connected || pendingQueries.length === 0) return null;
      const since = pendingQueries.shift()!;
      const after = log.filter((s) => s > since);
      const page = after.slice(0, cfg.pageSize);
      const hasMore = after.length > cfg.pageSize;
      const latest = page.length ? page[page.length - 1] : since;
      queue.push({ t: 'batch', batch: { roomId: 1, messages: page.map((s) => ({ sequence_number: s })), hasMore, latestSequenceNumber: latest } });
      return `server query since=${since} -> [${page.join(',')}] hasMore=${hasMore}`;
    },
    deliver() {
      if (!connected || queue.length === 0) return null;
      // out-of-order: sometimes a live push overtakes the one before it (two handlers resuming in the other order)
      let idx = 0;
      if (cfg.outOfOrder && queue.length >= 2 && queue[0].t === 'live' && queue[1].t === 'live' && rand() < 0.5) idx = 1;
      const ev = queue.splice(idx, 1)[0];
      if (ev.t === 'live') {
        known.add(ev.seq);
        cursor.onLive(ev.seq);
        return `deliver live ${ev.seq}`;
      }
      for (const m of ev.batch.messages) known.add(m.sequence_number);
      const next = cursor.onCatchUp(ev.batch);
      if (next !== null) pendingQueries.push(next);
      return `deliver batch latest=${ev.batch.latestSequenceNumber} hasMore=${ev.batch.hasMore}`;
    },
  };
  const names = Object.keys(ops) as Array<keyof typeof ops>;
  const weights: Record<keyof typeof ops, number> = { append: 4, disconnect: 1, connect: 2, serverQuery: 3, deliver: 5 };
  const bag = names.flatMap((n) => Array(weights[n]).fill(n));

  for (let i = 0; i < cfg.ops; i++) {
    const op = bag[Math.floor(rand() * bag.length)] as keyof typeof ops;
    const label = ops[op]();
    if (label === null) continue;
    const v = check(label);
    if (v) return { violation: v, trace };
  }

  // LIVENESS: stop the world, reconnect, drain everything. A client whose cursor
  // never lied must now hold the ENTIRE log. (This is "no message is permanently lost".)
  ops.disconnect();
  ops.connect();
  for (let guard = 0; guard < 10_000 && (queue.length || pendingQueries.length); guard++) {
    ops.serverQuery();
    ops.deliver();
  }
  const missing = log.filter((s) => !known.has(s));
  if (missing.length) return { violation: `LIVENESS BROKEN: after a full reconnect the client still lacks [${missing.join(',')}]`, trace };
  return { violation: null, trace };
}

export function findCounterexample(seeds: number, cfg: Config) {
  for (let seed = 1; seed <= seeds; seed++) {
    const r = run(seed, cfg);
    if (r.violation) return { seed, ...r };
  }
  return null;
}

describe('CatchUpCursor — model-based: "every message <= cursor is known", after EVERY step', () => {
  const base: Config = { pageSize: 3, ops: 80, burn: false, outOfOrder: false };

  it.each([
    ['gap-free sequence numbers', { ...base }],
    ['with burned sequence numbers (duplicate retries)', { ...base, burn: true }],
    ['page size 1 (maximal chaining)', { ...base, pageSize: 1, burn: true }],
    ['live pushes overtaking each other (live pushes swap places)', { ...base, outOfOrder: true }],
    ['overtaking + burned numbers + page size 2', { ...base, pageSize: 2, burn: true, outOfOrder: true }],
  ])('holds for 3000 random interleavings: %s', (_name, cfg) => {
    const found = findCounterexample(3000, cfg);
    if (found) console.error(`seed ${found.seed}\n${found.trace.join('\n')}\n${found.violation}`);
    expect(found).toBeNull();
  });
});
