import { apiFetch } from './client';
import { setAccessToken } from './tokenStore';
import type { User } from '../types';

interface AuthResponse {
  user: User;
  accessToken: string;
}

export async function register(username: string, email: string, password: string): Promise<User> {
  const data = await apiFetch<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email, password }),
  });
  setAccessToken(data.accessToken);
  return data.user;
}

export async function login(email: string, password: string): Promise<User> {
  const data = await apiFetch<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setAccessToken(data.accessToken);
  return data.user;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } finally {
    // Clear the in-memory token even if the network call fails — the user
    // asked to log out; a flaky request shouldn't leave them looking
    // logged-out in the UI but still holding a usable access token.
    setAccessToken(null);
  }
}

export async function fetchMe(): Promise<User> {
  return apiFetch<User>('/users/me');
}
