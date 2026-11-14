// C9 T-21 polling (04-UI-UX §1, 03-APP-FLOW E20): every 15 s, only while the tab is visible; one request at a time (the next timer starts after the
// previous poll settled); after a failure the last data stays and retries back off 5 s, 15 s, 30 s; a success returns to 15 s.
import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../types';

const PERIOD_MS = 15_000;
const BACKOFF_MS = [5_000, 15_000, 30_000] as const;

/** `poll` resolves true on success, false on failure. Restarts only when `restartKey` changes; unmount stops it. */
export function usePolling(poll: () => Promise<boolean>, restartKey: string) {
  const latest = useRef(poll);
  latest.current = poll;
  useEffect(() => {
    let stopped = false;
    let fails = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => void run(), fails === 0 ? PERIOD_MS : BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1]);
    };
    const run = async () => {
      if (stopped) return;
      if (document.visibilityState !== 'visible') return schedule(); // hidden tab: no request, look again next period
      let ok = false;
      try {
        ok = await latest.current();
      } catch {
        ok = false;
      }
      if (stopped) return;
      fails = ok ? 0 : fails + 1;
      schedule();
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [restartKey]);
}

export interface Polled<T> { data: T; updatedAt: Date; lost: boolean }

/** Server-rendered data first; polled data replaces it. A fresh server render (router.refresh) wins over older polled data. */
export function usePolled<T>(initial: T, generatedAt: string, fetcher: () => Promise<ActionResult<T>>, restartKey: string): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: initial, updatedAt: new Date(generatedAt), lost: false });
  useEffect(() => setState({ data: initial, updatedAt: new Date(generatedAt), lost: false }), [initial, generatedAt]);
  usePolling(async () => {
    const r = await fetcher();
    if (r.ok) setState({ data: r.data, updatedAt: new Date(), lost: false });
    else setState((s) => ({ ...s, lost: true }));
    return r.ok;
  }, restartKey);
  return state;
}
