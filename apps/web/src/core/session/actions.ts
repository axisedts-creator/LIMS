'use server';
// "Stay signed in" (04-UI-UX SessionTimeoutDialog). The server-action POST itself passes through middleware,
// which applies the CSRF check and calls resolveSession with touch:true; we just report the new deadlines.
import { getShellSession } from './server';

export async function keepAlive(): Promise<{ idleMs: number; absoluteMs: number } | null> {
  const s = await getShellSession();
  if (!s) return null;
  const now = Date.now();
  return { idleMs: Date.parse(s.idleExpiresAt) - now, absoluteMs: Date.parse(s.absoluteExpiresAt) - now };
}
