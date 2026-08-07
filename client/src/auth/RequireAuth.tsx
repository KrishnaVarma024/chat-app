import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

/** Gate for any authenticated route — mirrors the server's requireAuth
 * middleware, but purely for UX (the API is the real enforcement boundary;
 * this just avoids flashing a chat screen before redirecting). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isBooting } = useAuth();

  if (isBooting) return <div className="boot-screen">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
