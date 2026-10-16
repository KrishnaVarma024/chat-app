import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getRoom } from '../api/rooms';
import { fetchOlderMessages, fetchLatestMessages } from '../api/messages';
import {
  connectSocket,
  emitTypingStart,
  emitTypingStop,
  isSocketConnected,
  joinRoom,
  leaveRoom,
  sendChatMessage,
} from '../realtime/socket';
import { mergeMessages } from '../utils/mergeMessages';
import { CatchUpCursor } from '../realtime/catchUpCursor';
import { createTypingTracker } from '../realtime/typingTracker';
import { MessageItem } from '../components/MessageItem';
import { MessageInput } from '../components/MessageInput';
import { ApiError } from '../api/client';
import type {
  CatchUpBatch,
  DisplayMessage,
  Message,
  OptimisticMessage,
  PresenceEvent,
  RateLimitedEvent,
  Room,
  TypingEvent,
} from '../types';

// ARCHITECTURE_V2.md §10's receiving-client safety net: auto-clear a
// user's typing indicator if no FURTHER typing_start arrives within this
// window, regardless of whether typing_stop ever shows up. This is what
// stops a sender who crashes or loses their connection mid-keystroke
// (never gets a chance to emit typing_stop) from leaving a permanently
// stuck "X is typing…" on everyone else's screen — the receiver's own
// timeout owns this guarantee, not trust in the sender's cleanup.
const TYPING_AUTO_CLEAR_MS = 5000;

const NEAR_BOTTOM_THRESHOLD_PX = 100;
const LOAD_OLDER_THRESHOLD_PX = 100;

export function ChatRoomPage() {
  const { roomId: roomIdParam } = useParams();
  const roomId = Number(roomIdParam);
  const { user } = useAuth();

  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  // Phase 13 — ARCHITECTURE_V2.md §9. Purely additive knowledge built from
  // 'presence' broadcasts received since this component mounted — there is
  // no initial "who's online right now" snapshot on join (out of scope for
  // this phase), so a user who never sends a message and never changes
  // status while this room is open simply never appears here. That's a
  // known, deliberate gap (see the interview questions), not a bug.
  const [onlineUserIds, setOnlineUserIds] = useState<Set<number>>(new Set());
  // Who's currently shown as typing in THIS room, built entirely from
  // 'typing'/'stopped_typing' events — same "no initial snapshot, purely
  // additive from events seen since mount" shape as onlineUserIds above.
  const [typingUserIds, setTypingUserIds] = useState<Set<number>>(new Set());
  // The actual timer/membership bookkeeping lives in typingTracker.ts, not
  // here — this ref holds one tracker instance for the component's
  // lifetime; setTypingUserIds is its onChange callback, so the tracker's
  // internal state and this component's rendered state can never drift
  // apart. See typingTracker.test.ts for the auto-clear guarantee itself;
  // this component only ever calls markTyping/markStopped/reset.
  const typingTrackerRef = useRef(createTypingTracker((ids) => setTypingUserIds(ids), TYPING_AUTO_CLEAR_MS));
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 15 — shown while the server is telling this client to slow down.
  // Purely informational: the retry itself is connectionLifecycle.ts's job
  // (the refused messages are still in the outbox and get re-flushed on
  // their own), so nothing here needs to do anything but explain why
  // "Sending…" is taking a moment.
  const [rateLimitNotice, setRateLimitNotice] = useState<string | null>(null);
  const rateLimitNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const containerRef = useRef<HTMLDivElement>(null);
  // Set right before a state update that needs a specific scroll reaction
  // applied after React commits the new DOM — see the layout effect below.
  const scrollActionRef = useRef<'bottom' | 'preserve-from-prepend' | null>(null);
  const preservedScrollHeightRef = useRef<number>(0);

  // What this client already has of this room, and therefore what every
  // join_room after the first sends as sinceSequence (Phase 12 —
  // ARCHITECTURE_V2.md §7). Phase 16 turned the bare "highest sequence seen"
  // number into CatchUpCursor (realtime/catchUpCursor.ts) because the bare
  // number is unsafe: a live push arriving mid-catch-up would raise it past a
  // range not yet fetched, and the next page request or reconnect would skip
  // that range forever. A ref, not state: it's read inside socket event
  // handler closures and needs its CURRENT value at call time, and changing
  // it must never trigger a re-render.
  const cursorRef = useRef<CatchUpCursor>(new CatchUpCursor());

  // ---- Initial load: latest page of history for this room ----
  // Still a one-shot HTTP GET, not a socket event. Phase 10 replaces the
  // REPEATING poll (below) with a push; it deliberately does not touch how
  // a client bootstraps history when it first opens a room — that's Phase
  // 12's job (join_room + sinceSequence + a catch_up batch), which reuses
  // this exact cursor-pagination primitive for the "was disconnected, what
  // did I miss" case too.
  useEffect(() => {
    let cancelled = false;
    setIsLoadingInitial(true);
    setMessages([]);
    setOnlineUserIds(new Set());
    typingTrackerRef.current.reset();
    setError(null);

    (async () => {
      try {
        const [roomData, page] = await Promise.all([getRoom(roomId), fetchLatestMessages(roomId)]);
        if (cancelled) return;
        setRoom(roomData);
        setMessages(page.messages);
        setOlderCursor(page.next_cursor);
        setHasMoreOlder(page.has_more);
        // Baseline for Phase 12 catch-up: the live-join effect below fires
        // right after this (gated on isLoadingInitial), and its very first
        // join_room already has something concrete to send as
        // sinceSequence — "nothing sent after this" — rather than needing
        // a special "no history yet" case of its own.
        cursorRef.current = new CatchUpCursor(page.latest_sequence_number);
        scrollActionRef.current = 'bottom';
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load this room.');
      } finally {
        if (!cancelled) setIsLoadingInitial(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // ---- Live delivery: join this room's socket channel, listen for pushes ----
  // Gated on `isLoadingInitial` being false so this can't join and start
  // receiving 'new_message' events before the initial setMessages(page.messages)
  // above has run — that call REPLACES the whole array, so anything a fast
  // 'new_message' delivered in between would be silently overwritten. There's
  // still a small window between "initial load resolved" and "join_room ack'd"
  // where a message could theoretically be missed; Phase 12's catch-up
  // (re-querying by sequence number on every join) closes that gap generically
  // instead of this effect specially patching around it.
  useEffect(() => {
    if (isLoadingInitial) return;
    const socket = connectSocket();

    function handleConnect() {
      // Re-joins on every 'connect' event, not just the first — this
      // includes Socket.IO's own automatic reconnects (Phase 11 configures
      // the backoff/jitter timing; this is what actually acts on each
      // attempt that succeeds), so a brief drop-and-reconnect while this
      // page stays open re-subscribes to live events without the user
      // doing anything. Passing the cursor (cursorRef.beginJoin()) is what turns
      // that bare re-join into gap-filling (Phase 12): the server runs a
      // catch_up query for exactly what happened in this room while this
      // client was disconnected, and emits it before this join takes
      // effect for live delivery — see rooms.socket.ts's join_room handler.
      joinRoom(roomId, cursorRef.current.beginJoin());

      // The outbox (realtime/outbox.ts, wired in socket.ts) is what
      // actually re-sends anything still queued — this only updates what
      // THIS room's UI shows while that happens. Any of this room's own
      // messages still sitting in 'queued' are about to be flushed, so
      // reflect that immediately rather than waiting for their acks.
      setMessages((prev) =>
        prev.map((m) => ('status' in m && m.status === 'queued' ? { ...m, status: 'pending' as const } : m))
      );
    }

    function handleDisconnect() {
      // Any catch-up in flight died with the connection; the cursor itself is
      // still correct (live pushes never advanced it past the unfinished range).
      cursorRef.current.onDisconnect();
      // A message that was already flushed to the (now-dead) connection
      // and is still awaiting its ack has an unknown fate — Socket.IO
      // gives no "your emit definitely didn't arrive" signal, only
      // "the connection is gone now." The outbox itself doesn't need to
      // do anything here (the message is still sitting in its queue
      // regardless of what the UI shows, and will be re-flushed on the
      // next 'connect'); this just corrects the UI's optimistic guess
      // from "sending" back to "waiting for connection," since "sending"
      // is no longer true of a socket that isn't connected.
      setMessages((prev) =>
        prev.map((m) => ('status' in m && m.status === 'pending' ? { ...m, status: 'queued' as const } : m))
      );
    }

    function handleNewMessage(msg: Message) {
      const container = containerRef.current;
      const wasNearBottom = container
        ? container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_THRESHOLD_PX
        : true;
      setMessages((prev) => mergeMessages(prev, [msg]));
      cursorRef.current.onLive(msg.sequence_number);
      if (wasNearBottom) scrollActionRef.current = 'bottom';
    }

    function handleMessageAck(msg: Message) {
      // Same reconciliation path as the old HTTP confirmation: mergeMessages
      // keys on client_message_id, so this just replaces the optimistic
      // "Sending…" bubble with the confirmed row.
      setMessages((prev) => mergeMessages(prev, [msg]));
      cursorRef.current.onLive(msg.sequence_number);
    }

    // Phase 12 — ARCHITECTURE_V2.md §7. Fires once per page of missed
    // history: the very first batch after a join_room that named a
    // sinceSequence, and again for each has_more follow-up below. Keyed by
    // roomId (not just "any catch_up on this socket") because the socket
    // is a global singleton — if the user has already navigated away from
    // this room by the time a slow response lands, this effect's cleanup
    // will already have removed this exact listener, but the guard is
    // cheap insurance against any ordering surprise, not load-bearing.
    function handleCatchUp(batch: CatchUpBatch) {
      if (batch.roomId !== roomId) return;
      if (batch.messages.length > 0) {
        setMessages((prev) => mergeMessages(prev, batch.messages));
      }
      // onCatchUp advances the cursor to THIS page's end and says where the
      // next page starts (or null when the gap is closed). It is the page's
      // own end — not "the newest thing I've seen" — because a live push can
      // already have arrived with a much higher sequence number.
      const nextPageSince = cursorRef.current.onCatchUp(batch);
      if (nextPageSince !== null) {
        // Same mechanism as any other join — see rooms.socket.ts's comment
        // on why re-joining an already-joined room is a harmless no-op.
        joinRoom(roomId, nextPageSince);
      }
    }

    function handlePresence({ userId, status }: PresenceEvent) {
      setOnlineUserIds((prev) => {
        // Only construct a new Set when membership actually changes —
        // matters here specifically because this runs on every presence
        // broadcast for every room this socket is joined to, and an
        // identical-looking Set object would still trigger a re-render if
        // we always returned a fresh one.
        const isMember = prev.has(userId);
        if (status === 'online' && !isMember) {
          const next = new Set(prev);
          next.add(userId);
          return next;
        }
        if (status === 'offline' && isMember) {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        }
        return prev;
      });
    }

    function handleTyping({ userId: typingUserId, roomId: eventRoomId }: TypingEvent) {
      // Same defensive room-scoping as handleCatchUp (Phase 12) — this
      // socket is a global singleton, a stale event for a room this
      // component has already navigated away from should be a no-op here.
      if (eventRoomId !== roomId) return;
      typingTrackerRef.current.markTyping(typingUserId);
    }

    function handleStoppedTyping({ userId: typingUserId, roomId: eventRoomId }: TypingEvent) {
      if (eventRoomId !== roomId) return;
      typingTrackerRef.current.markStopped(typingUserId);
    }

    function handleRateLimited({ event, retryAfterSeconds }: RateLimitedEvent) {
      // Typing notices are deliberately invisible: a throttled typing
      // indicator isn't worth telling the user about.
      if (event !== 'send_message') return;
      setRateLimitNotice(`You're sending messages too quickly. Retrying automatically in ${retryAfterSeconds}s…`);
      if (rateLimitNoticeTimerRef.current) clearTimeout(rateLimitNoticeTimerRef.current);
      rateLimitNoticeTimerRef.current = setTimeout(() => setRateLimitNotice(null), retryAfterSeconds * 1000 + 200);
    }

    function handleSocketError(data: { error?: { code?: string; message?: string }; clientMessageId?: string }) {
      // Room-level errors (a bad join_room) don't carry a clientMessageId —
      // nothing to reconcile here, just a send_message failure.
      if (!data?.clientMessageId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.client_message_id === data.clientMessageId && 'status' in m ? { ...m, status: 'failed' as const } : m
        )
      );
    }

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('new_message', handleNewMessage);
    socket.on('message_ack', handleMessageAck);
    socket.on('catch_up', handleCatchUp);
    socket.on('presence', handlePresence);
    socket.on('typing', handleTyping);
    socket.on('stopped_typing', handleStoppedTyping);
    socket.on('rate_limited', handleRateLimited);
    socket.on('error', handleSocketError);
    // Already connected before this effect ran (e.g. navigating between
    // two rooms without ever losing the connection) — still passes
    // sinceSequence, same as handleConnect, since "already connected" says
    // nothing about whether messages arrived in this room while the user
    // was viewing some OTHER room. cursorRef is exactly
    // this room's own baseline set by the initial-load effect above, so
    // this join is correct whether the user is opening this room for the
    // first time or returning to it.
    if (socket.connected) joinRoom(roomId, cursorRef.current.beginJoin());

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('new_message', handleNewMessage);
      socket.off('message_ack', handleMessageAck);
      socket.off('catch_up', handleCatchUp);
      socket.off('presence', handlePresence);
      socket.off('typing', handleTyping);
      socket.off('stopped_typing', handleStoppedTyping);
      socket.off('rate_limited', handleRateLimited);
      socket.off('error', handleSocketError);
      if (rateLimitNoticeTimerRef.current) clearTimeout(rateLimitNoticeTimerRef.current);
      // Leaving the room (or this effect re-running for a different
      // roomId) should not leave an auto-clear timer running for a typing
      // indicator this component no longer renders — the reset at the top
      // of the initial-load effect handles the "switched rooms" case
      // already, but this covers the plain unmount case too.
      typingTrackerRef.current.reset();
      leaveRoom(roomId);
    };
  }, [roomId, isLoadingInitial]);

  // ---- Scrollback: load an older page when the user scrolls near the top ----
  const loadOlder = useCallback(async () => {
    if (!olderCursor || isLoadingOlder || !hasMoreOlder) return;
    setIsLoadingOlder(true);
    try {
      const page = await fetchOlderMessages(roomId, olderCursor);
      if (containerRef.current) {
        preservedScrollHeightRef.current = containerRef.current.scrollHeight;
        scrollActionRef.current = 'preserve-from-prepend';
      }
      setMessages((prev) => mergeMessages(prev, page.messages));
      setOlderCursor(page.next_cursor);
      setHasMoreOlder(page.has_more);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load older messages.');
    } finally {
      setIsLoadingOlder(false);
    }
  }, [roomId, olderCursor, isLoadingOlder, hasMoreOlder]);

  function handleScroll() {
    const el = containerRef.current;
    if (el && el.scrollTop < LOAD_OLDER_THRESHOLD_PX) {
      loadOlder();
    }
  }

  // Applies whichever scroll reaction the update that just committed asked
  // for — runs after the DOM reflects the new `messages`, before the
  // browser paints, so there's no visible flash either way.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (scrollActionRef.current === 'bottom') {
      el.scrollTop = el.scrollHeight;
    } else if (scrollActionRef.current === 'preserve-from-prepend') {
      el.scrollTop += el.scrollHeight - preservedScrollHeightRef.current;
    }
    scrollActionRef.current = null;
  }, [messages]);

  // ---- Optimistic send, through the durable outbox instead of a bare emit ----
  function handleSend(body: string) {
    if (!user) return;
    const clientMessageId = crypto.randomUUID();
    const optimistic: OptimisticMessage = {
      id: null,
      room_id: roomId,
      sender_id: user.id,
      sequence_number: null,
      client_message_id: clientMessageId,
      body,
      created_at: new Date().toISOString(),
      // Known, not guessed: sendChatMessage always enqueues before
      // attempting to flush, so whether this lands as 'pending' (about to
      // be flushed to a live connection) or 'queued' (nowhere to flush to
      // yet) is exactly the socket's actual connected state right now —
      // not an assumption that gets corrected later by a timeout.
      status: isSocketConnected() ? 'pending' : 'queued',
    };
    setMessages((prev) => [...prev, optimistic]);
    scrollActionRef.current = 'bottom';

    // No promise, no try/catch — sendChatMessage's job ends at "this is
    // now durably queued," not "this is now confirmed." Every subsequent
    // state transition (pending -> confirmed via message_ack, pending ->
    // queued via a disconnect, queued -> pending via the next connect,
    // queued/pending -> failed via a definitive error) is driven entirely
    // by the socket event handlers registered above — there is no
    // timeout anywhere in this path anymore. Phase 10 needed one because
    // there was nothing else that would ever revisit a stuck 'pending'
    // bubble; Phase 11's outbox is that revisiting mechanism, driven by
    // real events instead of a guessed delay.
    sendChatMessage(roomId, body, clientMessageId);
  }

  // Best-effort only — the typing payload itself carries nothing but a
  // userId (ARCHITECTURE_V2.md §10 keeps the relay minimal), so a name is
  // recovered from whatever this client has already rendered FROM that
  // sender. A user who's typing but has never sent a message in this
  // client's current view shows as "User #id", same fallback MessageItem
  // already uses for the identical "we don't know their name yet" case.
  function resolveDisplayName(senderId: number): string {
    const seen = messages.find((m) => m.sender_id === senderId);
    return seen?.sender_username ?? `User #${senderId}`;
  }

  const typingNames = Array.from(typingUserIds).map(resolveDisplayName);
  // Exercise B3: a plain comma-join scales badly past two or three names —
  // "Alice, Bob, Carol, Dave, Erin are typing…" is already unreadable, and
  // a room with dozens of members typing at once would make it worse, not
  // better. Collapsing to a count past two names is the same tradeoff a
  // notifications badge makes ("12 new messages", never listing all 12).
  const typingSummary =
    typingNames.length === 0
      ? ''
      : typingNames.length === 1
        ? typingNames[0]
        : typingNames.length === 2
          ? `${typingNames[0]} and ${typingNames[1]}`
          : `${typingNames.length} people`;

  if (isLoadingInitial) return <div className="boot-screen">Loading room…</div>;

  return (
    <div className="chat-room-page">
      <header className="page-header">
        <Link to="/rooms">&larr; Rooms</Link>
        <h1>{room?.name}</h1>
        <span className="room-id">#{roomId}</span>
      </header>

      {error && <p className="form-error">{error}</p>}
      {rateLimitNotice && <p className="form-error">{rateLimitNotice}</p>}

      <div className="message-list" ref={containerRef} onScroll={handleScroll}>
        {isLoadingOlder && <p className="loading-older">Loading older messages…</p>}
        {!hasMoreOlder && messages.length > 0 && <p className="history-start">Start of room history</p>}
        {messages.map((m) => (
          <MessageItem
            key={m.client_message_id}
            message={m}
            isOwn={m.sender_id === user?.id}
            ownUsername={user?.username ?? ''}
            isSenderOnline={onlineUserIds.has(m.sender_id)}
          />
        ))}
      </div>

      {typingNames.length > 0 && (
        <p className="typing-indicator">
          {typingSummary} {typingNames.length === 1 ? 'is' : 'are'} typing…
        </p>
      )}

      <MessageInput
        onSend={handleSend}
        onTypingStart={() => emitTypingStart(roomId)}
        onTypingStop={() => emitTypingStop(roomId)}
      />
    </div>
  );
}
