import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getRoom } from '../api/rooms';
import { fetchOlderMessages, fetchLatestMessages } from '../api/messages';
import { connectSocket, isSocketConnected, joinRoom, leaveRoom, sendChatMessage } from '../realtime/socket';
import { mergeMessages } from '../utils/mergeMessages';
import { MessageItem } from '../components/MessageItem';
import { MessageInput } from '../components/MessageInput';
import { ApiError } from '../api/client';
import type { CatchUpBatch, DisplayMessage, Message, OptimisticMessage, PresenceEvent, Room } from '../types';

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
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  // Set right before a state update that needs a specific scroll reaction
  // applied after React commits the new DOM — see the layout effect below.
  const scrollActionRef = useRef<'bottom' | 'preserve-from-prepend' | null>(null);
  const preservedScrollHeightRef = useRef<number>(0);

  // The highest sequence_number this client has ever displayed for this
  // room — what every join_room call after the very first one sends as
  // sinceSequence (Phase 12 — ARCHITECTURE_V2.md §7). A ref, not state:
  // it's read inside socket event handler closures and needs its CURRENT
  // value at call time, not the value from whichever render closed over
  // it — using state here would mean either stale reads or adding it to
  // the effect's dependency array and re-subscribing every socket listener
  // on every single message, which is unnecessary churn for a value that
  // never needs to trigger a re-render on its own.
  const lastKnownSequenceRef = useRef<number | null>(null);

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
        lastKnownSequenceRef.current = page.latest_sequence_number;
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
      // doing anything. Passing lastKnownSequenceRef.current is what turns
      // that bare re-join into gap-filling (Phase 12): the server runs a
      // catch_up query for exactly what happened in this room while this
      // client was disconnected, and emits it before this join takes
      // effect for live delivery — see rooms.socket.ts's join_room handler.
      joinRoom(roomId, lastKnownSequenceRef.current ?? undefined);

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
      lastKnownSequenceRef.current = Math.max(lastKnownSequenceRef.current ?? 0, msg.sequence_number);
      if (wasNearBottom) scrollActionRef.current = 'bottom';
    }

    function handleMessageAck(msg: Message) {
      // Same reconciliation path as the old HTTP confirmation: mergeMessages
      // keys on client_message_id, so this just replaces the optimistic
      // "Sending…" bubble with the confirmed row.
      setMessages((prev) => mergeMessages(prev, [msg]));
      lastKnownSequenceRef.current = Math.max(lastKnownSequenceRef.current ?? 0, msg.sequence_number);
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
      lastKnownSequenceRef.current = Math.max(lastKnownSequenceRef.current ?? 0, batch.latestSequenceNumber);
      if (batch.hasMore) {
        // Same mechanism as any other join — see rooms.socket.ts's
        // comment on why re-joining an already-joined room is a harmless
        // no-op. This is what turns "the gap was bigger than one page"
        // into a couple of quick round trips instead of ever silently
        // truncating history at the first page's boundary.
        joinRoom(roomId, lastKnownSequenceRef.current);
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
    socket.on('error', handleSocketError);
    // Already connected before this effect ran (e.g. navigating between
    // two rooms without ever losing the connection) — still passes
    // sinceSequence, same as handleConnect, since "already connected" says
    // nothing about whether messages arrived in this room while the user
    // was viewing some OTHER room. lastKnownSequenceRef.current is exactly
    // this room's own baseline set by the initial-load effect above, so
    // this join is correct whether the user is opening this room for the
    // first time or returning to it.
    if (socket.connected) joinRoom(roomId, lastKnownSequenceRef.current ?? undefined);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('new_message', handleNewMessage);
      socket.off('message_ack', handleMessageAck);
      socket.off('catch_up', handleCatchUp);
      socket.off('presence', handlePresence);
      socket.off('error', handleSocketError);
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

  if (isLoadingInitial) return <div className="boot-screen">Loading room…</div>;

  return (
    <div className="chat-room-page">
      <header className="page-header">
        <Link to="/rooms">&larr; Rooms</Link>
        <h1>{room?.name}</h1>
        <span className="room-id">#{roomId}</span>
      </header>

      {error && <p className="form-error">{error}</p>}

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

      <MessageInput onSend={handleSend} />
    </div>
  );
}
