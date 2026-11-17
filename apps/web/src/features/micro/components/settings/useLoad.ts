'use client';
// Lazy tab data: runs `load` (a server action) when `key` changes or `reload()` is called. A failed or thrown load keeps the tab usable with `fail` set.
import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../../server/types';
import type { Fail } from '../common';

export function useLoad<T>(load: () => Promise<ActionResult<T[]>>, key: string, enabled = true) {
  const [state, setState] = useState<{ rows: T[]; loaded: boolean; fail?: Fail }>({ rows: [], loaded: false });
  const [tick, setTick] = useState(0);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((s) => ({ ...s, loaded: false }));
    latest.current().then(
      (r) => { if (alive) setState(r.ok ? { rows: r.data, loaded: true } : { rows: [], loaded: true, fail: r }); },
      () => { if (alive) setState({ rows: [], loaded: true, fail: { ok: false, status: 0, code: 'common.internal' } }); },
    );
    return () => { alive = false; };
  }, [key, tick, enabled]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
