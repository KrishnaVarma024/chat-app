import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getRoom } from '../api/rooms';
import { fetchOlderMessages, fetchLatestMessages } from '../api/messages';
import { connectSocket, joinRoom, leaveRoom, sendChatMessage } from '../realtime/socket';
import { mergeMessages } from '../utils/mergeMessages';
import { MessageItem } from '../components/MessageItem';
import { MessageInput } from '../components/MessageInput';
import { ApiError } from '../api/client';
import type { DisplayMessage, Message, OptimisticMessage, Room } from '../types';

const NEAR_BOTTOM_THRESHOLD_PX = 100;
const LOAD_OLDER_THRESHOLD_PX = 100;
// Safety net only — see handleSend's comment. Generous on purpose: a
// healthy round trip resolves in well under a second, so this only ever
// fires when something actually went wrong (dropped event, connection
// blip Phase 11 hasn't learned to queue through yet).
const SEND_ACK_TIMEOUT_MS = 8000;

export function ChatRoomPage() {
  const { roomId: roomIdParam } = useParams();
  const roomId = Number(roomIdParam);
  const { user } = useAuth();

  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
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
    setError(null);

    (async () => {
      try {
        const [roomData, page] = await Promise.all([getRoom(roomId), fetchLatestMessages(roomId)]);
        if (cancelled) return;
        setRoom(roomData);
        setMessages(page.messages);
        setOlderCursor(page.next_cursor);
        setHasMoreOlder(page.has_more);
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
      // includes Socket.IO's own automatic reconnects (never disabled),
      // so a brief drop-and-reconnect while this page stays open
      // re-subscribes to live events without the user doing anything.
      // Phase 11/12 build proper backoff timing and gap-filling on top of
      // this; this is just "don't stay silently un-joined after a
      // reconnect."
      joinRoom(roomId);
    }

    function handleNewMessage(msg: Message) {
      const container = containerRef.current;
      const wasNearBottom = container
        ? container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_THRESHOLD_PX
        : true;
      setMessages((prev) => mergeMessages(prev, [msg]));
      if (wasNearBottom) scrollActionRef.current = 'bottom';
    }

    function handleMessageAck(msg: Message) {
      // Same reconciliation path as the old HTTP confirmation: mergeMessages
      // keys on client_message_id, so this just replaces the optimistic
      // "Sending…" bubble with the confirmed row.
      setMessages((prev) => mergeMessages(prev, [msg]));
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
    socket.on('new_message', handleNewMessage);
    socket.on('message_ack', handleMessageAck);
    socket.on('error', handleSocketError);
    if (socket.connected) joinRoom(roomId); // already connected before this effect ran

    return () => {
      socket.off('connect', handleConnect);
      socket.off('new_message', handleNewMessage);
      socket.off('message_ack', handleMessageAck);
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

  // ---- Optimistic send, over the socket instead of HTTP ----
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
      status: 'pending',
    };
    setMessages((prev) => [...prev, optimistic]);
    scrollActionRef.current = 'bottom';

    // Fire-and-forget emit — no promise to await, no try/catch here.
    // Confirmation (or rejection) arrives later as a 'message_ack' or
    // 'error' event carrying this same clientMessageId (handled in the
    // effect above). This IS a real behavior change from the HTTP version:
    // there is no synchronous "did this even reach the server" signal
    // anymore, which is exactly why the timeout below exists — Phase 11's
    // offline queue is the real, permanent fix for "the socket was down
    // when I hit send," not this timeout. This is just a stopgap so a
    // dropped message doesn't say "Sending…" forever in the meantime.
    sendChatMessage(roomId, body, clientMessageId);

    window.setTimeout(() => {
      setMessages((prev) =>
        prev.map((m) =>
          m.client_message_id === clientMessageId && 'status' in m && m.status === 'pending'
            ? { ...m, status: 'failed' as const }
            : m
        )
      );
    }, SEND_ACK_TIMEOUT_MS);
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
          />
        ))}
      </div>

      <MessageInput onSend={handleSend} />
    </div>
  );
}
