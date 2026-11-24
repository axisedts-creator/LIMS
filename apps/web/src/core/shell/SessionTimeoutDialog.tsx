'use client';
// Auto-keeps the session alive in the background so the user is never timed out or signed out unexpectedly.
import { useEffect } from 'react';
import { keepAlive } from '../session/actions';

export function SessionTimeoutDialog({ idleMs: _idleMs, absoluteMs: _absoluteMs }: { idleMs: number; absoluteMs: number }) {
  useEffect(() => {
    // Keep session alive periodically (every 2 minutes)
    const interval = setInterval(() => {
      void keepAlive();
    }, 2 * 60_000);

    // Keep session alive on user activity (throttled to at most once per minute)
    let lastActivity = Date.now();
    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivity > 60_000) {
        lastActivity = now;
        void keepAlive();
      }
    };

    window.addEventListener('mousemove', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity, { passive: true });
    window.addEventListener('click', onActivity, { passive: true });
    window.addEventListener('scroll', onActivity, { passive: true });

    // Initial keep alive
    void keepAlive();

    return () => {
      clearInterval(interval);
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('click', onActivity);
      window.removeEventListener('scroll', onActivity);
    };
  }, []);

  return null;
}
