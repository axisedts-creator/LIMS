'use client';
// C16.T-Q4 client hosts: bind the W6/W7 components to the server actions and to the polling route. Nothing here holds a token or a secret.
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ToastProvider } from '@lims/ui/components/Toast';
import { QueueConsole, type QueueConsoleActions } from './QueueConsole';
import { QueueSetup, type QueueSetupActions } from './QueueSetup';
import type { Queue, QueueCounter, QueueDisplayRow, QueueToken } from './queue-model';
import * as act from '../server/queue-actions';

const key = () => crypto.randomUUID();

/** Server action result → value, or an Error carrying `problem` so the components can map the code to a message. */
function unwrap<T>(r: act.ActionResult<T>): T {
  if (r.ok) return r.data;
  throw Object.assign(new Error(r.code), { problem: { code: r.code } });
}

/** Q4 poll through the BFF route with the background header, so polling never extends the idle session (W6; 08 A25 D-206). */
async function pollTokens(centreId: string): Promise<QueueToken[]> {
  const res = await fetch(`/engagement/queue/tokens?centre_id=${encodeURIComponent(centreId)}`, { headers: { 'X-Lims-Background': '1' }, cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`poll ${res.status}`);
  const body = (await res.json()) as { data?: QueueToken[] };
  return Array.isArray(body.data) ? body.data : [];
}

export function QueueConsoleHost(props: { labName: string; centreId: string; queues: Queue[]; counters: QueueCounter[]; tokens: QueueToken[] }) {
  const { centreId } = props;
  const actions = useMemo<QueueConsoleActions>(() => ({
    listTokens: () => pollTokens(centreId),
    callNext: async (q, c) => unwrap(await act.callNextAction(q, c)),
    recall: async (t) => unwrap(await act.recallAction(t.id, t.version)),
    serve: async (t, c) => unwrap(await act.serveAction(t.id, t.version, c)),
    complete: async (t) => unwrap(await act.completeAction(t.id, t.version)),
    skip: async (t) => unwrap(await act.skipAction(t.id, t.version)),
    transfer: async (t, to) => unwrap(await act.transferAction(t.id, t.version, to, key())),
    issue: async (i) => unwrap(await act.issueAction(i, key())),
  }), [centreId]);
  return <ToastProvider><QueueConsole {...props} actions={actions} /></ToastProvider>;
}

export function QueueSetupHost(props: { centreId: string; queues: Queue[]; counters: QueueCounter[]; displays: QueueDisplayRow[] }) {
  const router = useRouter();
  const { centreId } = props;
  const actions = useMemo<QueueSetupActions>(() => {
    const done = async <T,>(p: Promise<act.ActionResult<T>>) => { unwrap(await p); router.refresh(); };
    return {
      createQueue: (b) => done(act.createQueueAction(b, key())),
      updateQueue: (q, b) => done(act.updateQueueAction(q.id, q.version, b)),
      createCounter: (b) => done(act.createCounterAction(b, key())),
      updateCounter: (c, b) => done(act.updateCounterAction(c.id, c.version, b)),
      revokeDisplay: (d) => done(act.revokeDisplayAction(d.id, d.version)),
      // Success redirects to /queue-display inside the action; only a failure comes back here.
      pairDisplay: async (b) => { const r = await act.pairDisplayAction(centreId, b); if (!r.ok) unwrap(r); },
    };
  }, [centreId, router]);
  return <ToastProvider><QueueSetup {...props} actions={actions} /></ToastProvider>;
}
