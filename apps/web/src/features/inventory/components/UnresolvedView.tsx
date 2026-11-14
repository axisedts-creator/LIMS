'use client';
// S15 Waiting consumption (04-UI-UX §3 S15; AC-12.9; TRD #75 list, #77 resolve, #78 dismiss). Help: inventory.help.consumption_model.
// LD-140 (2026-11-13): list + dialogs; this screen has NO primary button (row actions are secondary); status = tone + icon + word.
// Gating: the page needs inventory.item.read; "Post to store…" and "Dismiss" need inventory.master.manage (the API enforces it too).
// The server posts the movements with the ORIGINAL business date; the screen only sends the store (or the reason) and re-reads the queue.
import { useRef, useState, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { useToast } from '@lims/ui/components/Toast';
import { dismissFactAction, listFactsAction, resolveFactAction } from '../server/actions';
import type { CodedValue, Fact, Instrument, Store, TestRef } from '../server/types';
import { CONSUMPTION_HELP } from './RulesView';
import { Chip, Pick, ProblemBanner, useAttemptKey, type Failure } from './shared';

type IsoUtc = NonNullable<ComponentProps<typeof DateText>['value']>;
const KIND: Record<string, string> = { test: 'Test result', analyte: 'Analyte result', rerun: 'Rerun', qc: 'QC result', calibration: 'Calibration', fixed: 'Analyser-day' };

export interface UnresolvedViewProps {
  facts: readonly Fact[];
  nextCursor?: string | undefined;
  instruments: readonly Instrument[];
  tests: readonly TestRef[];
  stores: readonly Store[];
  /** reason_group fact_dismiss */
  reasons: readonly CodedValue[];
  canManage: boolean;
}

export function UnresolvedView(p: UnresolvedViewProps) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<readonly Fact[]>(p.facts);
  const [cursor, setCursor] = useState(p.nextCursor);
  const [more, setMore] = useState<Failure>();
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<{ kind: 'post' | 'dismiss'; fact: Fact }>();

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    const r = await listFactsAction(cursor);
    setLoading(false);
    if (!r.ok) return setMore(r);
    setMore(undefined);
    setRows((s) => [...s, ...r.data.data]);
    setCursor(r.data.page.next_cursor);
  };
  const done = (fact: Fact, title: string) => {
    setActing(undefined);
    setRows((s) => s.filter((f) => f.id !== fact.id));
    toast.show({ tone: 'success', title });
    router.refresh();
  };

  const columns: ColumnDef<Fact>[] = [
    { id: 'occurred', header: 'Occurred', isRowHeader: true, cell: (f) => (f.occurred_at ? <DateText value={f.occurred_at as IsoUtc} withTime /> : '—') },
    { id: 'kind', header: 'Kind', cell: (f) => KIND[f.fact_kind] ?? f.fact_kind },
    { id: 'analyser', header: 'Analyser', cell: (f) => p.instruments.find((i) => i.id === f.instrument_id)?.instrument_code ?? '—' },
    { id: 'test', header: 'Test', cell: (f) => { const t = p.tests.find((x) => x.id === f.test_id); return t ? `${t.code} · ${t.name}` : '—'; } },
    { id: 'reason', header: 'Reason', cell: () => <Chip tone="warning" label="No store found" /> },
    ...(p.canManage
      ? [{
          id: 'actions',
          header: 'Actions',
          cell: (f: Fact) => (
            <Inline gap={1}>
              <Button size="sm" onPress={() => setActing({ kind: 'post', fact: f })}>Post to store…</Button>
              <Button size="sm" variant="ghost" onPress={() => setActing({ kind: 'dismiss', fact: f })}>Dismiss</Button>
            </Inline>
          ),
        }]
      : []),
  ];

  return (
    <section aria-label="Waiting consumption">
      <PageHeader title="Waiting consumption" helpKey="inventory.help.consumption_model" />
      <Stack>
        <p>These deductions could not be posted because no store is linked to the analyser and no default store is set.</p>
        <a className="lims-link" href={CONSUMPTION_HELP}>Help: how automatic deduction works</a>
        <DataTable caption="Waiting consumption" columns={columns} rows={rows} getRowId={(f) => f.id} emptyState={{ title: 'Nothing waiting' }} />
        <ProblemBanner problem={more} />
        {cursor ? <div><Button isLoading={loading} onPress={() => void loadMore()}>Load more</Button></div> : null}
      </Stack>
      {acting?.kind === 'post' ? <PostDialog fact={acting.fact} stores={p.stores} onClose={() => setActing(undefined)} onDone={() => done(acting.fact, 'Posted. The deductions use the original date.')} /> : null}
      {acting?.kind === 'dismiss' ? <DismissDialog fact={acting.fact} reasons={p.reasons} onClose={() => setActing(undefined)} onDone={() => done(acting.fact, 'Dismissed')} /> : null}
    </section>
  );
}

function PostDialog({ fact, stores, onClose, onDone }: { fact: Fact; stores: readonly Store[]; onClose: () => void; onDone: () => void }) {
  const key = useAttemptKey();
  const busy = useRef(false);
  const [store, setStore] = useState<string>();
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (busy.current) return;
    if (!store) return setError('Store is required');
    setError(undefined);
    busy.current = true;
    setSaving(true);
    const r = await resolveFactAction(fact.id, fact.version ?? 1, key.get(store), store);
    busy.current = false;
    setSaving(false);
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };
  return (
    <Dialog
      title="Post to store"
      isOpen
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Close</Button>
          <Button isLoading={saving} onPress={() => void submit()}>Post</Button>
        </>
      }
    >
      <Stack>
        <ProblemBanner problem={problem} />
        <Pick label="Store" name="store_id" isRequired options={stores.filter((s) => s.is_active).map((s) => ({ value: s.id, label: `${s.store_code} · ${s.name}` }))} value={store} error={error} onChange={setStore} />
      </Stack>
    </Dialog>
  );
}

function DismissDialog({ fact, reasons, onClose, onDone }: { fact: Fact; reasons: readonly CodedValue[]; onClose: () => void; onDone: () => void }) {
  const key = useAttemptKey();
  const busy = useRef(false);
  const [reason, setReason] = useState<string>();
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (busy.current) return;
    if (!reason) return setError('Reason is required');
    setError(undefined);
    busy.current = true;
    setSaving(true);
    const r = await dismissFactAction(fact.id, fact.version ?? 1, key.get(reason), reason);
    busy.current = false;
    setSaving(false);
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };
  return (
    <Dialog
      title="Dismiss waiting record"
      isOpen
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Close</Button>
          <Button variant="danger" isLoading={saving} onPress={() => void submit()}>Dismiss</Button>
        </>
      }
    >
      <Stack>
        <ProblemBanner problem={problem} />
        <p>A dismissed record is never posted to stock.</p>
        <Pick label="Reason" name="reason_code" isRequired options={reasons.map((c) => ({ value: c.code, label: c.display }))} value={reason} error={error} onChange={setReason} />
      </Stack>
    </Dialog>
  );
}
