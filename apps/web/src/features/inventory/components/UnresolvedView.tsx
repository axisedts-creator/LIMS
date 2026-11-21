'use client';
// S15 Waiting consumption (04-UI-UX §3 S15; AC-12.9; TRD #75 list, #77 resolve, #78 dismiss). Help: inventory.help.consumption_model.
// LD-140 (2026-11-13): list + dialogs; this screen has NO primary button (row actions are secondary); status = tone + icon + word.
// Gating: the page needs inventory.item.read; "Post to store…" and "Dismiss" need inventory.master.manage (the API enforces it too).
// The server posts the movements with the ORIGINAL business date; the screen only sends the store (or the reason) and re-reads the queue.
// T0D-UICONSOLE-1 (LD-353 template 2 CONSOLE): PageHeader, one (empty) FilterBar, StatTiles (Waiting, Analysers affected, Oldest age) above a SplitConsole: queue at left
// (Age first, API order), detail at right (the columns the table had, the reason chip, History), sticky bar = the row actions the table had, same gate, same dialogs.
import { useRef, useState, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SplitConsole } from '@lims/ui/components/SplitConsole';
import { Stack } from '@lims/ui/components/Stack';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { Facts, History, ShortcutKey, hhmm, itemProps, oldest, useNow } from './consoleParts';
import { dismissFactAction, listFactsAction, resolveFactAction } from '../server/actions';
import type { CodedValue, Fact, Instrument, Store, TestRef } from '../server/types';
import { CONSUMPTION_HELP } from './RulesView';
import { Chip, Pick, ProblemBanner, useAttemptKey, type Failure } from './shared';

type IsoUtc = NonNullable<ComponentProps<typeof DateText>['value']>;
const KIND: Record<string, string> = { test: 'Test result', analyte: 'Analyte result', rerun: 'Rerun', qc: 'QC result', calibration: 'Calibration', fixed: 'Analyser-day' };
const HEADERS = ['Age', 'Occurred', 'Kind', 'Analyser', 'Test'];

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
  const [selectedId, setSelectedId] = useState<string>();
  const now = useNow();

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

  const kind = (f: Fact) => KIND[f.fact_kind] ?? f.fact_kind;
  const analyser = (f: Fact) => p.instruments.find((i) => i.id === f.instrument_id)?.instrument_code ?? '—';
  const test = (f: Fact) => { const x = p.tests.find((y) => y.id === f.test_id); return x ? `${x.code} · ${x.name}` : '—'; };
  const age = (f: Fact) => (f.occurred_at ? now - Date.parse(f.occurred_at) : 0);
  const sel = rows.find((f) => f.id === selectedId);
  const title = t('inventory.nav.unresolved');

  const list = (
    <div className="lims-data-table"><div className="lims-table-scroll">
      <table className="lims-table">
        <caption className="lims-visually-hidden">{title}</caption>
        <thead><tr>{HEADERS.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow colSpan={HEADERS.length}><EmptyState title="Nothing waiting" /></EmptyRow> : null}
          {rows.map((f) => (
            <tr key={f.id} {...itemProps(f.id, selectedId, setSelectedId)}>
              <td suppressHydrationWarning>{f.occurred_at ? hhmm(age(f)) : '—'}</td>
              <td>{f.occurred_at ? <DateText value={f.occurred_at as IsoUtc} withTime /> : '—'}</td>
              <td>{kind(f)}</td>
              <td>{analyser(f)}</td>
              <td>{test(f)}</td>
            </tr>
          ))}
        </tbody>
        {rows.length === 0 ? <PlaceholderRows colSpan={HEADERS.length} /> : null}
      </table>
    </div></div>
  );

  const detail = sel ? (
    // T0D-UIGUARD-1-INVENTORY (LD-436 R7): the detail is a kit Card with a title row, no raw h2.
    <Card title={kind(sel)}>
      <Facts items={[
        ['Occurred', sel.occurred_at ? <DateText key="o" value={sel.occurred_at as IsoUtc} withTime /> : '—'],
        ['Kind', kind(sel)],
        ['Analyser', analyser(sel)],
        ['Test', test(sel)],
        ['Reason', <Chip key="r" tone="warning" label="No store found" />],
      ]} />
      <History events={sel.occurred_at ? [['Occurred', sel.occurred_at] as const] : []} />
    </Card>
  ) : <p>Select a waiting record to see it here.</p>;

  // T0D-UICONSOLE-1: the row actions the table had (inventory.master.manage only), now for the selected record; P runs the first one.
  const post = sel ? () => setActing({ kind: 'post', fact: sel }) : undefined;
  const bar = sel && p.canManage ? (
    <Inline gap={1}>
      <Button size="sm" onPress={post!}>Post to store… (P)</Button>
      <Button size="sm" variant="ghost" onPress={() => setActing({ kind: 'dismiss', fact: sel })}>Dismiss</Button>
    </Inline>
  ) : undefined;

  return (
    <section aria-label={title}>
      <PageHeader title={title} helpKey="inventory.help.consumption_model" />
      <Stack>
        <p>These deductions could not be posted because no store is linked to the analyser and no default store is set.</p>
        <a className="lims-link" href={CONSUMPTION_HELP}>Help: how automatic deduction works</a>
        {/* the screen reads no filter today: the one FilterBar of the template stays empty (no invented filter) */}
        <FilterBar filters={[]} value={{}} onChange={() => undefined} onReset={() => undefined} />
        <StatTileRow>
          <StatTile label="Waiting" value={String(rows.length)} />
          <StatTile label="Analysers affected" value={String(new Set(rows.flatMap((f) => (f.instrument_id ? [f.instrument_id] : []))).size)} />
          <StatTile label="Oldest age" value={oldest(rows.filter((f) => f.occurred_at).map(age))} />
        </StatTileRow>
        <ShortcutKey letter="P" run={bar ? post : undefined}>
          <SplitConsole list={list} detail={detail} actions={bar} listLabel="Waiting records" detailLabel="Waiting record" />
        </ShortcutKey>
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
