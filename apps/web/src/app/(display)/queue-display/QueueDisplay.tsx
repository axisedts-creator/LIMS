'use client';
// Polls the same-origin BFF every 5 s (If-None-Match); 3 failed polls -> stale (keeps last board); 401 -> unpaired.
import { useEffect, useRef, useState } from 'react';
import { QueueBoard, type IsoUtc } from '@lims/ui/components/QueueBoard';

type Board = {
  centre_display_name: string;
  board_version: number;
  generated_at: IsoUtc;
  now_calling: { token_label: string; counter_display_name: string; queue_display_name: string; called_at: string }[];
  waiting: { queue_display_name: string; waiting_count: number }[];
};
type Phase = 'connecting' | 'live' | 'stale' | 'unpaired';

const POLL_MS = 5_000;
const MAX_FAILURES = 3;
const NEW_FLASH_MS = 3_000;

export function QueueDisplay({ initial }: { initial: 'connecting' | 'unpaired' }) {
  const [phase, setPhase] = useState<Phase>(initial);
  const [revoked, setRevoked] = useState(false);
  const [board, setBoard] = useState<Board | undefined>();
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [staleSince, setStaleSince] = useState<IsoUtc | undefined>();
  const etag = useRef<string | undefined>(undefined);
  const lastOk = useRef<IsoUtc | undefined>(undefined);
  const seen = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    if (initial === 'unpaired') return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctl = new AbortController();

    const fail = () => {
      failures += 1;
      if (failures >= MAX_FAILURES) {
        setStaleSince((s) => s ?? lastOk.current ?? (new Date().toISOString() as IsoUtc));
        setPhase('stale');
      }
    };

    const poll = async () => {
      try {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (etag.current) headers['If-None-Match'] = etag.current;
        const res = await fetch('/queue-display/api/board', {
          headers,
          cache: 'no-store',
          credentials: 'same-origin',
          signal: ctl.signal,
        });
        if (stopped) return;
        if (res.status === 401) {
          setRevoked(true);
          setPhase('unpaired');
          return; // stop polling: the screen must be paired again
        }
        if (res.status === 304 || res.status === 200) {
          if (res.status === 200) {
            const b = (await res.json()) as Board;
            etag.current = res.headers.get('etag') ?? undefined;
            const now = new Set(b.now_calling.map((c) => c.token_label));
            const prev = seen.current;
            const added = prev ? [...now].filter((t) => !prev.has(t)) : [];
            seen.current = now;
            setBoard(b);
            if (added.length) {
              setFresh(new Set(added));
              setTimeout(() => setFresh(new Set()), NEW_FLASH_MS);
            }
            lastOk.current = b.generated_at;
          }
          failures = 0;
          setStaleSince(undefined);
          setPhase('live');
        } else {
          fail();
        }
      } catch {
        if (!stopped) fail();
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      stopped = true;
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [initial]);

  if (phase === 'unpaired') {
    return (
      <section role="status" className="lims-queue-display-state">
        <h1>{revoked ? 'This screen is no longer paired' : 'Not paired'}</h1>
        {!revoked && <p>Ask a lab administrator to pair this screen</p>}
      </section>
    );
  }
  if (!board) {
    return (
      <section role="status" className="lims-queue-display-state">
        <h1>Connecting…</h1>
      </section>
    );
  }
  // LD-145: the kit QueueBoard owns the stale banner (one live region, no duplicate).
  return (
    <QueueBoard
      title={board.centre_display_name}
      nowCalling={board.now_calling.map((c) => ({
        token: c.token_label,
        counter: c.counter_display_name,
        queue: c.queue_display_name,
        isNew: fresh.has(c.token_label),
      }))}
      waiting={board.waiting.map((w) => ({ queue: w.queue_display_name, count: w.waiting_count }))}
      serverTime={board.generated_at}
      connection={phase === 'stale' ? 'stale' : 'live'}
      {...(phase === 'stale' && staleSince ? { staleSince } : {})}
      soundEnabled={false}
    />
  );
}
