import { ValidationError } from '../errors';

/**
 * Cursors are opaque to the client on purpose (see ARCHITECTURE.md §7) — the
 * wire format below is base64url(JSON.stringify({ seq })), but callers
 * should never construct one by hand from a raw sequence_number they got
 * some other way. The API always hands back a ready-to-use `next_cursor`
 * (see rooms.routes.ts); a client only ever echoes back a cursor it was
 * previously given. That's what makes "opaque" actually mean something —
 * if this encoding ever needs to change (e.g. to a composite key once a
 * single sequence_number stops being enough), every client that only ever
 * forwards `next_cursor` keeps working without modification.
 *
 * base64url (not plain base64) is deliberate too: it's safe to drop
 * straight into a query string with no `+`/`/`/`=` characters that would
 * otherwise need percent-encoding.
 */
export function encodeCursor(sequenceNumber: number): string {
  return Buffer.from(JSON.stringify({ seq: sequenceNumber })).toString('base64url');
}

export function decodeCursor(cursor: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Invalid cursor');
  }

  const seq = (parsed as { seq?: unknown } | null)?.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
    throw new ValidationError('Invalid cursor');
  }
  return seq;
}
