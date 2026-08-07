import { apiFetch } from './client';
import type { Message, MessagesPage } from '../types';

export function sendMessage(roomId: number, body: string, clientMessageId: string): Promise<Message> {
  return apiFetch<Message>(`/rooms/${roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body, clientMessageId }),
  });
}

/** Poll direction: "give me everything since the last message I've rendered." */
export function pollMessages(roomId: number, afterCursor: string | null, limit = 50): Promise<MessagesPage> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (afterCursor) qs.set('after', afterCursor);
  return apiFetch<MessagesPage>(`/rooms/${roomId}/messages?${qs.toString()}`);
}

/** Scrollback direction: "give me the page of history just before this cursor." */
export function fetchOlderMessages(roomId: number, beforeCursor: string, limit = 50): Promise<MessagesPage> {
  const qs = new URLSearchParams({ limit: String(limit), before: beforeCursor });
  return apiFetch<MessagesPage>(`/rooms/${roomId}/messages?${qs.toString()}`);
}

/** Initial load: no cursor at all — the latest page. */
export function fetchLatestMessages(roomId: number, limit = 50): Promise<MessagesPage> {
  const qs = new URLSearchParams({ limit: String(limit) });
  return apiFetch<MessagesPage>(`/rooms/${roomId}/messages?${qs.toString()}`);
}
