import { apiFetch } from './client';
import type { Room } from '../types';

export function listMyRooms(): Promise<Room[]> {
  return apiFetch<Room[]>('/rooms');
}

export function getRoom(roomId: number): Promise<Room> {
  return apiFetch<Room>(`/rooms/${roomId}`);
}

export function createRoom(name: string): Promise<Room> {
  return apiFetch<Room>('/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function joinRoom(roomId: number): Promise<void> {
  return apiFetch<void>(`/rooms/${roomId}/join`, { method: 'POST' });
}

export function leaveRoom(roomId: number): Promise<void> {
  return apiFetch<void>(`/rooms/${roomId}/leave`, { method: 'POST' });
}
