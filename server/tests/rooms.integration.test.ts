import { describe, it, expect } from 'vitest';
import { buildTestApp, supertest } from './helpers/testApp';
import { registerUser, createRoom } from './helpers/fixtures';

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('rooms & membership', () => {
  it('creating a room makes the creator a member automatically', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);

    const listRes = await supertest(app).get('/rooms').set(auth(user.accessToken));
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((r: { id: number }) => r.id === roomId)).toBe(true);
  });

  it('a non-member gets 403 reading a room that exists; a nonexistent room is 404', async () => {
    const app = buildTestApp();
    const owner = await registerUser(app);
    const outsider = await registerUser(app);
    const roomId = await createRoom(app, owner.accessToken);

    const notAMember = await supertest(app).get(`/rooms/${roomId}`).set(auth(outsider.accessToken));
    const doesntExist = await supertest(app).get('/rooms/999999999').set(auth(owner.accessToken));

    // Two DIFFERENT failure modes on purpose (rooms.middleware.ts): a real
    // room you're not in is 403 (you're known, just not allowed); a room
    // that was never created is 404 (nothing to be forbidden FROM).
    expect(notAMember.status).toBe(403);
    expect(doesntExist.status).toBe(404);
  });

  it('joining grants access; leaving revokes it again', async () => {
    const app = buildTestApp();
    const owner = await registerUser(app);
    const joiner = await registerUser(app);
    const roomId = await createRoom(app, owner.accessToken);

    const beforeJoin = await supertest(app).get(`/rooms/${roomId}`).set(auth(joiner.accessToken));
    expect(beforeJoin.status).toBe(403);

    const joinRes = await supertest(app).post(`/rooms/${roomId}/join`).set(auth(joiner.accessToken));
    expect(joinRes.status).toBe(204);

    const afterJoin = await supertest(app).get(`/rooms/${roomId}`).set(auth(joiner.accessToken));
    expect(afterJoin.status).toBe(200);

    const leaveRes = await supertest(app).post(`/rooms/${roomId}/leave`).set(auth(joiner.accessToken));
    expect(leaveRes.status).toBe(204);

    const afterLeave = await supertest(app).get(`/rooms/${roomId}`).set(auth(joiner.accessToken));
    expect(afterLeave.status).toBe(403);
  });
});

describe('messages: send, idempotency, and cursor pagination', () => {
  it('sequential sends get contiguous sequence numbers', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);

    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await supertest(app)
        .post(`/rooms/${roomId}/messages`)
        .set(auth(user.accessToken))
        .send({ body: `message ${i}`, clientMessageId: crypto.randomUUID() });
      expect(res.status).toBe(201);
      seqs.push(res.body.sequence_number);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('resending the same client_message_id returns the ORIGINAL message, not a duplicate', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);
    const clientMessageId = crypto.randomUUID();

    const first = await supertest(app)
      .post(`/rooms/${roomId}/messages`)
      .set(auth(user.accessToken))
      .send({ body: 'original body', clientMessageId });
    const retry = await supertest(app)
      .post(`/rooms/${roomId}/messages`)
      .set(auth(user.accessToken))
      .send({ body: 'THIS SHOULD BE IGNORED', clientMessageId });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.sequence_number).toBe(first.body.sequence_number);
    expect(retry.body.body).toBe('original body');

    const listRes = await supertest(app)
      .get(`/rooms/${roomId}/messages`)
      .set(auth(user.accessToken));
    expect(listRes.body.messages).toHaveLength(1);
  });

  it('rejects an empty body and a non-UUID client_message_id with 400 VALIDATION_ERROR', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);

    const emptyBody = await supertest(app)
      .post(`/rooms/${roomId}/messages`)
      .set(auth(user.accessToken))
      .send({ body: '', clientMessageId: crypto.randomUUID() });
    const badId = await supertest(app)
      .post(`/rooms/${roomId}/messages`)
      .set(auth(user.accessToken))
      .send({ body: 'hi', clientMessageId: 'not-a-uuid' });

    expect(emptyBody.status).toBe(400);
    expect(emptyBody.body.error.code).toBe('VALIDATION_ERROR');
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('VALIDATION_ERROR');
  });

  // One of Phase 8's three named load-bearing scenarios: pagination
  // stability. The CONCURRENT-insert-while-scrolling version of this
  // (scripts/scrollback-stability-test.mjs) needs real Postgres — this is
  // the sequential half: cursor correctness itself, provable anywhere.
  it('poll (?after) returns only newer messages; scrollback (?before) returns older ones, oldest-first', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);

    for (let i = 0; i < 8; i++) {
      await supertest(app)
        .post(`/rooms/${roomId}/messages`)
        .set(auth(user.accessToken))
        .send({ body: `msg ${i}`, clientMessageId: crypto.randomUUID() });
    }

    // Initial load — latest page, limit 3: should be sequence numbers 6,7,8.
    const initial = await supertest(app)
      .get(`/rooms/${roomId}/messages?limit=3`)
      .set(auth(user.accessToken));
    expect(initial.status).toBe(200);
    expect(initial.body.messages.map((m: { sequence_number: number }) => m.sequence_number)).toEqual([6, 7, 8]);
    expect(initial.body.has_more).toBe(true);

    // Scrollback from the oldest message we have (seq 6) should give us
    // 3,4,5 — strictly older, still ascending order within the page.
    // Messages don't carry their own cursor field (only the response
    // envelope's next_cursor does) — encodeCursorForTest mirrors the
    // server's own encodeCursor so we can build one for a sequence number
    // we already know, the same way a real caller builds it from
    // next_cursor rather than a per-message field.
    const oldestLoadedSeq = initial.body.messages[0].sequence_number;
    const scrollback = await supertest(app)
      .get(`/rooms/${roomId}/messages?before=${encodeCursorForTest(oldestLoadedSeq)}&limit=3`)
      .set(auth(user.accessToken));
    expect(scrollback.status).toBe(200);
    expect(scrollback.body.messages.map((m: { sequence_number: number }) => m.sequence_number)).toEqual([3, 4, 5]);

    // Seed the FIRST poll from latest_sequence_number, not from
    // initial.body.next_cursor. This tripped up a first draft of this
    // test, and it's a genuinely easy trap: the initial (no-cursor) load
    // runs through the SAME code path as `?before=...` (rooms.routes.ts's
    // else-branch), so its `next_cursor` is a scrollback cursor — "keep
    // scrolling into older history from here" (encodes the OLDEST message
    // in the page: seq 6) — not a poll cursor. Using it as `?after=`
    // re-requested everything from seq 6 onward, which is exactly why this
    // assertion first failed with 2 unexpected messages (7 and 8) instead
    // of 0. The correct way to seed a poll is latest_sequence_number,
    // which is what client/src/api/cursor.ts's encodeCursor is
    // specifically, deliberately for.
    const pollCursor = encodeCursorForTest(initial.body.latest_sequence_number);

    // Poll from the latest known cursor: nothing new yet.
    const pollNoNews = await supertest(app)
      .get(`/rooms/${roomId}/messages?after=${pollCursor}`)
      .set(auth(user.accessToken));
    expect(pollNoNews.body.messages).toHaveLength(0);

    // Send one more, then poll again from the same cursor: exactly the
    // one new message, never a re-delivery of anything already seen.
    await supertest(app)
      .post(`/rooms/${roomId}/messages`)
      .set(auth(user.accessToken))
      .send({ body: 'msg 8 (the real one)', clientMessageId: crypto.randomUUID() });
    const pollWithNews = await supertest(app)
      .get(`/rooms/${roomId}/messages?after=${pollCursor}`)
      .set(auth(user.accessToken));
    expect(pollWithNews.body.messages.map((m: { sequence_number: number }) => m.sequence_number)).toEqual([9]);
  });

  it('cannot specify both ?after and ?before at once', async () => {
    const app = buildTestApp();
    const user = await registerUser(app);
    const roomId = await createRoom(app, user.accessToken);

    const res = await supertest(app)
      .get(`/rooms/${roomId}/messages?after=abc&before=xyz`)
      .set(auth(user.accessToken));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// Mirrors client/src/api/cursor.ts's encodeCursor — same base64url(JSON)
// shape as src/rooms/cursor.ts on the server. Only needed here because the
// scrollback test above wants to construct a cursor for a sequence number
// it already knows, rather than only ever consuming cursors the server
// handed back (which is what every real caller does).
function encodeCursorForTest(sequenceNumber: number): string {
  return Buffer.from(JSON.stringify({ seq: sequenceNumber })).toString('base64url');
}
