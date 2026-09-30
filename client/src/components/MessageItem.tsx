import type { DisplayMessage } from '../types';

interface MessageItemProps {
  message: DisplayMessage;
  isOwn: boolean;
  ownUsername: string;
  // Undefined (not just false) on purpose for isOwn messages — "is the
  // current user online" is a trivially true, meaningless question (you're
  // looking at the screen), so ChatRoomPage never even looks it up for its
  // own messages. See ChatRoomPage's onlineUserIds — presence is only ever
  // known for OTHER users, seeded entirely from 'presence' broadcasts this
  // client has actually received since it connected, with no initial
  // snapshot (ARCHITECTURE_V2.md §9 deliberately scopes this phase to
  // broadcasts only, not an on-join roster).
  isSenderOnline?: boolean;
}

export function MessageItem({ message, isOwn, ownUsername, isSenderOnline }: MessageItemProps) {
  const isOptimistic = 'status' in message;
  const displayName = isOwn ? ownUsername : (message.sender_username ?? `User #${message.sender_id}`);

  return (
    <div className={`message-item ${isOwn ? 'own' : ''} ${isOptimistic ? `optimistic-${message.status}` : ''}`}>
      <div className="message-meta">
        {!isOwn && (
          <span
            className={`presence-dot ${isSenderOnline ? 'online' : 'offline'}`}
            title={isSenderOnline ? 'Online' : 'Offline (or unknown)'}
          />
        )}
        <span className="message-sender">{displayName}</span>
        <time>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
      <div className="message-body">{message.body}</div>
      {isOptimistic && message.status === 'queued' && (
        <span className="message-status queued">Waiting for connection…</span>
      )}
      {isOptimistic && message.status === 'pending' && <span className="message-status">Sending…</span>}
      {isOptimistic && message.status === 'failed' && <span className="message-status failed">Failed to send</span>}
    </div>
  );
}
