// Mirrors server/src/rooms/cursor.ts's wire format, documented in
// ARCHITECTURE.md §7: base64url(JSON.stringify({ seq })). The client is
// NOT supposed to decode or hand-construct cursors it received from the
// server — those stay fully opaque, so the server is free to change this
// format later without breaking anyone. This one narrow exception exists
// for a real gap: every messages response only ever returns ONE
// `next_cursor`, oriented toward the direction it was asked in. Loading a
// room's initial page uses the *scrollback* direction (`before`), so its
// `next_cursor` continues scrollback — it's not usable to start polling
// forward. `latest_sequence_number` is returned as a plain integer
// specifically so the client always knows the current position without
// decoding anything; this helper turns that already-known integer into
// the documented cursor format, purely to seed the very first poll.
export function encodeCursor(sequenceNumber: number): string {
  return btoa(JSON.stringify({ seq: sequenceNumber }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
