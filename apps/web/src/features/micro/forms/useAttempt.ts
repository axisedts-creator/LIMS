'use client';
// One submit attempt of a dialog form (LD-140: kit forms only). The Idempotency-Key stays the same while the form is unchanged (a retry after a failure re-sends
// the same key) and changes whenever a value changes; reopening the dialog creates a new one. A synchronous in-flight guard stops a double click before React re-renders.
// `micro.culture_invalid_transition` refreshes the page so the user sees the culture's current state (AC-03.3).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { newKey, type Fail } from '../components/common';
import type { ActionResult } from '../server/types';

export function useAttempt() {
  const router = useRouter();
  const key = useRef(newKey());
  const inflight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Fail>();

  /** Call from every onChange: a changed form is a new request. */
  const touch = () => {
    key.current = newKey();
    setFail(undefined);
  };

  /** Runs `f` once at a time. Resolves with the data on success; on a refusal the failure is shown and undefined is returned. */
  const send = async <T,>(f: (idempotencyKey: string) => Promise<ActionResult<T>>): Promise<T | undefined> => {
    if (inflight.current) return undefined;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      const r = await f(key.current);
      if (r.ok) return r.data;
      setFail(r);
      if (r.code === 'micro.culture_invalid_transition') router.refresh();
      return undefined;
    } catch {
      setFail({ ok: false, status: 0, code: 'common.internal' });
      return undefined;
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  return { busy, fail, touch, send };
}
