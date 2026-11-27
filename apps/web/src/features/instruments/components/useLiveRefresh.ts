'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Refreshes the current Next.js Server Component route periodically and whenever the tab becomes visible,
 * giving operators real-time updates for agent health, instrument link telemetry, and incoming analyzer messages.
 * Pass enabled=false while editing forms or filling dialogs to avoid losing client input.
 */
export function useLiveRefresh(intervalMs = 5_000, enabled = true): void {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const refreshIfVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        routerRef.current.refresh();
      }
    };
    const timer = setInterval(refreshIfVisible, intervalMs);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', refreshIfVisible);
    }
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', refreshIfVisible);
      }
    };
  }, [intervalMs, enabled]);
}
