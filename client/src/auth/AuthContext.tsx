import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { refreshAccessToken } from '../api/client';
import { onAccessTokenChange } from '../api/tokenStore';
import { login as apiLogin, register as apiRegister, logout as apiLogout, fetchMe } from '../api/auth';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  // True only during the one-time boot check (see below) — lets the app
  // show a blank/loading screen instead of flashing the login page for a
  // split second before we know whether the refresh cookie is still good.
  isBooting: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isBooting, setIsBooting] = useState(true);

  // Boot-time silent refresh: the access token lives in memory only, so a
  // hard page reload always starts with none. Rather than immediately
  // showing the login screen, spend one round trip trying to exchange the
  // httpOnly refresh cookie (if the browser still has a valid one) for a
  // fresh access token — this is what makes "I refreshed the tab" not the
  // same thing as "I got logged out."
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const refreshed = await refreshAccessToken();
      if (cancelled) return;
      if (refreshed) {
        try {
          const me = await fetchMe();
          if (!cancelled) setUser(me);
        } catch {
          if (!cancelled) setUser(null);
        }
      }
      if (!cancelled) setIsBooting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // If the access token ever gets cleared out from under us — e.g. a poll
  // request 401s, the client's single-flight refresh attempt also fails
  // because the refresh cookie is gone or was revoked (Phase 2 reuse
  // detection) — reflect that as "logged out" in the UI too, instead of
  // leaving stale user state around that no longer has a working session.
  useEffect(() => {
    return onAccessTokenChange((token) => {
      if (token === null) setUser(null);
    });
  }, []);

  async function login(email: string, password: string) {
    const me = await apiLogin(email, password);
    setUser(me);
  }

  async function register(username: string, email: string, password: string) {
    const me = await apiRegister(username, email, password);
    setUser(me);
  }

  async function logout() {
    await apiLogout();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, isBooting, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
