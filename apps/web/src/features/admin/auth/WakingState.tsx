'use client';
// T0D-WAKE-1 (LD-277, audit RS-07): the API did not answer (timeout / connection failure: a sleeping host is waking up).
// One distinct state, M-series entry card (T0D-MSERIES-5): heading, line, Retry; ONE automatic retry 15 s after mount, then stop.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import type { ActionResult } from './messages';

const AUTO_RETRY_MS = 15_000;

export function WakingState({ onRetry }: { onRetry?: () => void | Promise<void> }) {
  const router = useRouter();
  const retry = useRef<() => void | Promise<void>>(() => {});
  retry.current = onRetry ?? (() => router.refresh());
  useEffect(() => {
    const t = setTimeout(() => void retry.current(), AUTO_RETRY_MS); // mount-only: a re-render never restarts it
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="lims-auth-card">
      <span className="lims-auth-pill">Please wait</span>
      <h1>The server is waking up</h1>
      <p>This can take up to a minute after a quiet period. We will try again by ourselves once.</p>
      <Button variant="primary" onPress={() => void retry.current()}>
        Retry
      </Button>
    </div>
  );
}

type Failure = Extract<ActionResult, { ok: false }>;

/** Submit + failure state shared by the sign-in forms; `retry` re-sends the last values (waking state stays mounted meanwhile). */
export function useAuthSubmit(action: (fd: FormData) => Promise<ActionResult>) {
  const [failure, setFailure] = useState<Failure>();
  const [pending, setPending] = useState(false);
  const last = useRef<FormData | undefined>(undefined);
  const busy = useRef(false);
  async function send(fd: FormData) {
    if (busy.current) return;
    busy.current = true;
    last.current = fd;
    setPending(true);
    setFailure((f) => (f?.waking ? f : undefined));
    try {
      const r = await action(fd);
      setFailure(r && !r.ok ? r : undefined);
    } catch {
      setFailure({ ok: false, code: 'common.dependency_unavailable' });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const retry = () => (last.current ? send(last.current) : undefined);
  return { failure, pending, send, retry };
}
