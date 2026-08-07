import type { DisplayMessage } from '../types';

interface MessageItemProps {
  message: DisplayMessage;
  isOwn: boolean;
  ownUsername: string;
}

export function MessageItem({ message, isOwn, ownUsername }: MessageItemProps) {
  const isOptimistic = 'status' in message;
  const displayName = isOwn ? ownUsername : (message.sender_username ?? `User #${message.sender_id}`);

  return (
    <div className={`message-item ${isOwn ? 'own' : ''} ${isOptimistic ? `optimistic-${message.status}` : ''}`}>
      <div className="message-meta">
        <span className="message-sender">{displayName}</span>
        <time>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
      <div className="message-body">{message.body}</div>
      {isOptimistic && message.status === 'pending' && <span className="message-status">Sending…</span>}
      {isOptimistic && message.status === 'failed' && <span className="message-status failed">Failed to send</span>}
    </div>
  );
}
