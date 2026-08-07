import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getRoom } from '../api/rooms';
import { pollMessages, fetchOlderMessages, fetchLatestMessages, sendMessage } from '../api/messages';
import { encodeCursor } from '../api/cursor';
import { usePolling } from '../hooks/usePolling';
import { mergeMessages } from '../utils/mergeMessages';
import { MessageItem } from '../components/MessageItem';
import { MessageInput } from '../components/MessageInput';
import { ApiError } from '../api/client';
import type { DisplayMessage, OptimisticMessage, Room } from '../types';

const BASE_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 30000;
const NEAR_BOTTOM_THRESHOLD_PX = 100;
const LOAD_OLDER_THRESHOLD_PX = 100;

export function ChatRoomPage() {
  const { roomId: roomIdParam } = useParams();
  const roomId = Number(roomIdParam);
  const { user } = useAuth();

  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [pollCursor, setPollCursor] = useState<string | null>(null);
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
  const pollCursorRef = useRef<string | null>(null);
  pollCursorRef.current = pollCursor;

  // ---- Initial load: latest page of history for this room ----
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
        // See api/cursor.ts — this is the one place the client constructs
        // a cursor itself, seeded from the plain integer latest_sequence_number
        // rather than decoding anything the server sent as opaque.
        setPollCursor(encodeCursor(page.latest_sequence_number));
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

  // ---- Poll loop: everything after our cursor, on an interval ----
  const onPoll = useCallback(async (): Promise<boolean> => {
    const cursor = pollCursorRef.current;
    if (cursor === null) return false;
    const page = await pollMessages(roomId, cursor);
    setPollCursor(page.next_cursor ?? cursor);
    if (page.messages.length === 0) return false;

    const container = containerRef.current;
    const wasNearBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_THRESHOLD_PX
      : true;

    setMessages((prev) => mergeMessages(prev, page.messages));
    if (wasNearBottom) scrollActionRef.current = 'bottom';
    return true;
  }, [roomId]);

  usePolling({
    baseIntervalMs: BASE_POLL_INTERVAL_MS,
    maxIntervalMs: MAX_POLL_INTERVAL_MS,
    onPoll,
    enabled: !isLoadingInitial && pollCursor !== null,
  });

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

  // ---- Optimistic send ----
  async function handleSend(body: string) {
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

    try {
      const confirmed = await sendMessage(roomId, body, clientMessageId);
      setMessages((prev) => mergeMessages(prev, [confirmed]));
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.client_message_id === clientMessageId && 'status' in m ? { ...m, status: 'failed' as const } : m
        )
      );
    }
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
