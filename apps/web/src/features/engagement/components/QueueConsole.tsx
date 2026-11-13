'use client';
// C16.T-Q4 W6 queue console (04-UI-UX W6; 03-APP-FLOW §7.1; US-EN-21.1–21.6). Props are injected (see __tests__/t-q4.harness.tsx header); the BFF adds the bearer token.
// LD-138: tester/writer reset. No patient data is read or shown: tokens carry at most booking_id (AC-21.6). "My counter" lives in memory only.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { DataTable } from '@lims/ui/components/DataTable';
import { KeyboardShortcutsDialog } from '@lims/ui/components/KeyboardShortcutsDialog';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { TokenSlip } from '@lims/ui/components/TokenSlip';
import { useToast } from '@lims/ui/components/Toast';
import { shortcuts } from '@/core/shortcuts/registry';
import { MAX_RECALLS, SUGGEST_SKIP_AFTER, mmss, problemMessage, upsertToken, waitingOrder, type Queue, type QueueCounter, type QueueToken } from './queue-model';

const PAGE_ID = 'staff.engagement.queue';
const DEFAULT_POLL_MS = 5_000; // W6 Polling: Q4 every 5 s
/** Sent by the poll helper so the C2 idle rule is unaffected (W6; 08 A25 D-206). The BFF maps it to touch:false. */
export const BACKGROUND_HEADER = 'X-Lims-Background';

export interface QueueConsoleActions {
  listTokens(): Promise<QueueToken[]>;
  callNext(queueId: string, counterId: string): Promise<QueueToken | null>;
  recall(token: QueueToken): Promise<QueueToken>;
  serve(token: QueueToken, counterId: string): Promise<QueueToken>;
  complete(token: QueueToken): Promise<QueueToken>;
  skip(token: QueueToken): Promise<QueueToken>;
  transfer(token: QueueToken, toQueueId: string): Promise<{ from: QueueToken; to: QueueToken }>;
  issue(input: { queueId: string; priority: 'normal' | 'priority' }): Promise<QueueToken>;
}
export interface QueueConsoleProps {
  labName: string;
  centreId: string;
  queues: readonly Queue[];
  counters: readonly QueueCounter[];
  tokens: readonly QueueToken[];
  actions: QueueConsoleActions;
  pollMs?: number;
}

// LD-140: every status shows tone + word via the kit StatusChip (10-DESIGN-SYSTEM §6).
const STATUS: Record<string, readonly ['neutral' | 'info' | 'success', string]> = {
  waiting: ['neutral', 'Waiting'], called: ['info', 'Called'], serving: ['info', 'Being served'], completed: ['success', 'Done'],
  skipped: ['neutral', 'Skipped'], cancelled: ['neutral', 'Cancelled'], transferred: ['info', 'Transferred'], expired: ['neutral', 'Expired'],
};
const PRIORITIES = [{ value: 'normal', label: 'Normal' }, { value: 'priority', label: 'Priority' }] as const;

export function QueueConsole({ labName, queues, counters, tokens: initial, actions, pollMs = DEFAULT_POLL_MS }: QueueConsoleProps) {
  const toast = useToast();
  const active = useMemo(() => queues.filter((q) => q.is_active).sort((a, b) => a.sort_order - b.sort_order), [queues]);
  const activeCounters = useMemo(() => counters.filter((c) => c.is_active).sort((a, b) => a.sort_order - b.sort_order), [counters]);
  const [tokens, setTokens] = useState<QueueToken[]>([...initial]);
  const [tab, setTab] = useState(active[0]?.id ?? '');
  const [counterId, setCounterId] = useState<string>();
  const [current, setCurrent] = useState<QueueToken | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string>();
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueQueue, setIssueQueue] = useState('');
  const [issuePriority, setIssuePriority] = useState<'normal' | 'priority'>('normal');
  const [transferOpen, setTransferOpen] = useState(false);
  const [target, setTarget] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [slip, setSlip] = useState<{ queue: string; token: QueueToken } | null>(null);
  const inflight = useRef(new Set<string>());

  // Polling (W6): Q4 every 5 s; a failed poll keeps the last list. Elapsed time re-renders every second.
  useEffect(() => {
    const poll = setInterval(() => {
      actions.listTokens().then((t) => setTokens([...t]), () => undefined);
    }, pollMs);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [actions, pollMs]);

  const queueName = useCallback((id: string) => queues.find((q) => q.id === id)?.display_name ?? '', [queues]);
  // The token this counter is on: the local one, else (after a reload) the called/serving token of "My counter".
  const shown = current ?? (counterId ? tokens.find((t) => t.counter_id === counterId && (t.status === 'called' || t.status === 'serving')) ?? null : null);
  const waiting = useMemo(() => tokens.filter((t) => t.status === 'waiting' && t.queue_id === tab).sort(waitingOrder), [tokens, tab]);
  const counts = useMemo(() => new Map(active.map((q) => [q.id, tokens.filter((t) => t.status === 'waiting' && t.queue_id === q.id).length])), [active, tokens]);

  /** One request per action at a time (double click / key repeat), reporting failures inline. */
  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    try { await fn(); setError(undefined); } catch (e) { setError(problemMessage(e)); } finally { inflight.current.delete(key); }
  }, []);

  const callNext = () => run('next', async () => {
    if (!counterId) { setError('Choose your counter first.'); return; }
    const t = await actions.callNext(tab, counterId);
    if (!t) { toast.show({ tone: 'info', title: 'No one is waiting.' }); return; }
    setCurrent(t);
    setTokens((l) => upsertToken(l, t));
  });
  const step = (key: string, fn: (t: QueueToken) => Promise<QueueToken>, ends: boolean) => run(key, async () => {
    const t = shown;
    if (!t) return;
    const r = await fn(t);
    setTokens((l) => upsertToken(l, r));
    setCurrent(ends ? null : r);
  });
  const recall = () => { if (shown && shown.status === 'called' && shown.call_count < MAX_RECALLS) void step('recall', (t) => actions.recall(t), false); };
  const serve = () => { if (shown && shown.status === 'called' && counterId) void step('serve', (t) => actions.serve(t, counterId), false); };
  const done = () => { if (shown) void step('done', (t) => actions.complete(t), true); };
  const skip = () => { if (shown) void step('skip', (t) => actions.skip(t), true); };
  const openTransfer = () => { if (shown) { setTarget(undefined); setTransferOpen(true); } };
  const openIssue = () => { setIssueQueue(tab); setIssuePriority('normal'); setIssueOpen(true); };

  const confirmTransfer = () => run('transfer', async () => {
    const t = shown;
    if (!t || !target) return;
    const r = await actions.transfer(t, target);
    setTokens((l) => upsertToken(upsertToken(l, r.from), r.to));
    setCurrent(null);
    setTransferOpen(false);
    toast.show({ tone: 'success', title: `Transferred as ${r.to.token_label}` });
  });
  const confirmIssue = () => run('issue', async () => {
    const queueId = issueQueue || tab;
    const t = await actions.issue({ queueId, priority: issuePriority });
    setTokens((l) => upsertToken(l, t));
    setSlip({ queue: queueName(queueId), token: t });
    setIssueOpen(false);
  });

  // Page shortcuts (C0 registry, 04-UI-UX §4). Handlers read the latest state through a ref so one registration serves every render.
  const latest = useRef({ callNext, recall, serve, done, skip, openTransfer, openIssue });
  latest.current = { callNext, recall, serve, done, skip, openTransfer, openIssue };
  useEffect(() => {
    // STOPGAP pending CR .orchestra/cr/T-Q4.md: Call next is Alt+C. W6 (04-UI-UX:227/:231) says Alt+N, but Alt+N is a global key and register() throws on it (AC-0D-7.5).
    return shortcuts.register(
      PAGE_ID,
      { key: 'Alt+C', description: 'Call next', run: () => void latest.current.callNext() },
      { key: 'Alt+R', description: 'Recall the current token', run: () => latest.current.recall() },
      { key: 'Alt+S', description: 'Serving: start serving the current token', run: () => latest.current.serve() },
      { key: 'Alt+D', description: 'Done: complete the current token', run: () => latest.current.done() },
      { key: 'Alt+K', description: 'Skip the current token', run: () => latest.current.skip() },
      { key: 'Alt+T', description: 'Transfer the current token to another queue', run: () => latest.current.openTransfer() },
      { key: 'Alt+I', description: 'Issue a token', run: () => latest.current.openIssue() },
    );
  }, []);

  const hasToken = !!shown;
  const calls = shown?.call_count ?? 0;
  const otherQueues = active.filter((q) => q.id !== shown?.queue_id);

  return (
    <div className="lims-queue-console">
      <div className="lims-queue-toolbar">
        <Select label="My counter" name="counter" placeholder="Choose a counter" options={activeCounters.map((c) => ({ value: c.id, label: c.display_name }))} {...(counterId ? { value: counterId } : {})} onChange={setCounterId} />
        <Button variant="primary" shortcut="Alt+C" onPress={() => void callNext()}>Call next</Button>
        <Button onPress={openIssue} shortcut="Alt+I">Issue token</Button>
        <Button variant="ghost" onPress={() => setHelpOpen(true)}>Keyboard shortcuts</Button>
      </div>
      {error ? <p role="alert" className="lims-error">{error}</p> : null}

      <Tabs aria-label="Queues" items={active.map((q) => ({ id: q.id, label: q.display_name, badge: String(counts.get(q.id) ?? 0) }))} selectedId={tab} onChange={setTab}>
        <DataTable
          caption="Waiting tokens"
          rows={waiting}
          getRowId={(t) => t.id}
          emptyState={{ title: 'No one is waiting.' }}
          columns={[
            { id: 'token', header: 'Token', isRowHeader: true, cell: (t) => t.token_label },
            { id: 'priority', header: 'Priority', cell: (t) => (t.priority === 'priority' ? 'Priority' : 'Normal') },
            { id: 'waiting', header: 'Waiting', cell: (t) => mmss(t.issued_at, now) },
            { id: 'booking', header: 'Booking', cell: (t) => (t.booking_id ? '✓' : '—') },
          ]}
        />
      </Tabs>

      <section aria-label="Current token" className="lims-queue-current">
        {shown ? (
          <>
            <p className="lims-queue-big">{shown.token_label}</p>
            <p><StatusChip kind="generic" status={shown.status} tone={STATUS[shown.status]?.[0] ?? 'neutral'} label={STATUS[shown.status]?.[1] ?? shown.status} /></p>
            <p>{`Calls: ${calls}`}</p>
            {calls >= SUGGEST_SKIP_AFTER ? <p>{`Suggest: skip after ${SUGGEST_SKIP_AFTER} calls.`}</p> : null}
          </>
        ) : (
          <p>No token on your counter.</p>
        )}
        <div className="lims-queue-actions">
          <Button isDisabled={!hasToken || shown.status !== 'called' || calls >= MAX_RECALLS} shortcut="Alt+R" onPress={recall}>Recall</Button>
          <Button isDisabled={!hasToken || shown.status !== 'called' || !counterId} shortcut="Alt+S" onPress={serve}>Serving</Button>
          <Button isDisabled={!hasToken} shortcut="Alt+D" onPress={done}>Done</Button>
          <Button isDisabled={!hasToken} shortcut="Alt+K" onPress={skip}>Skip</Button>
          <Button isDisabled={!hasToken || otherQueues.length === 0} shortcut="Alt+T" onPress={openTransfer}>Transfer…</Button>
        </div>
      </section>

      {slip ? (
        <div className="lims-queue-slip">
          <TokenSlip labName={labName} heading={slip.queue} big={slip.token.token_label} lines={[]} issuedAt={slip.token.issued_at as ComponentProps<typeof TokenSlip>['issuedAt']} /* kit prints the date/time (LD-143) */ />
          <Button onPress={() => window.print()}>Print slip</Button>
          <Button variant="ghost" onPress={() => setSlip(null)}>Close slip</Button>
        </div>
      ) : null}

      <Dialog
        title="Issue token"
        isOpen={issueOpen}
        onClose={() => setIssueOpen(false)}
        size="sm"
        footer={<><Button variant="ghost" onPress={() => setIssueOpen(false)}>Cancel</Button><Button variant="primary" onPress={() => void confirmIssue()}>Issue</Button></>}
      >
        <Select label="Queue" name="queue" options={active.map((q) => ({ value: q.id, label: q.display_name }))} value={issueQueue} onChange={setIssueQueue} />
        <Select label="Priority" name="priority" options={[...PRIORITIES]} value={issuePriority} onChange={setIssuePriority} />
      </Dialog>

      <Dialog
        title="Transfer token"
        isOpen={transferOpen}
        onClose={() => setTransferOpen(false)}
        size="sm"
        footer={<><Button variant="ghost" onPress={() => setTransferOpen(false)}>Cancel</Button><Button variant="primary" isDisabled={!target} onPress={() => void confirmTransfer()}>Transfer</Button></>}
      >
        <Select label="Target queue" name="target_queue" placeholder="Choose a queue" options={otherQueues.map((q) => ({ value: q.id, label: q.display_name }))} {...(target ? { value: target } : {})} onChange={setTarget} />
      </Dialog>

      <KeyboardShortcutsDialog
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        groups={[{ id: 'queue', title: 'Queue console', shortcuts: shortcuts.list(PAGE_ID).map((s) => ({ keys: s.key, description: s.description })) }]}
      />
    </div>
  );
}
