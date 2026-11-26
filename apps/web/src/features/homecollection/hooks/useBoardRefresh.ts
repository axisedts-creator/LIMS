'use client';

// C17 02-TRD §3.3: the home-collection screens poll through the BFF every 30 s [CONV] (02-CV §2.4; no browser Realtime),
// so what the phlebotomist app uploads shows here without a manual refresh. Nothing is polled while the tab is hidden, and
// `paused` stops it while a dialog is open so the row being worked on does not change underneath it.
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export const BOARD_REFRESH_MS = 30_000;

export function useBoardRefresh(paused = false): void {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (paused) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') routerRef.current.refresh();
    };
    const timer = setInterval(refresh, BOARD_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [paused]);
}
