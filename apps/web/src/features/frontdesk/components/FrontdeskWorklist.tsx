'use client';
// 04-UI-UX §6 Front-desk worklist: tabs Recollection needed / Booking cancelled after registration / Pre-registered today / Possible duplicates
// created today (F26, registration.create only). DataTable keys: ↑/↓ rows, Enter opens the order, R resolves the focused flag row.
// T0D-UIDASH-2 (LD-436 worklist mock, LD-437 exact match): PageHeader with caption and New registration / ONE Card holding the Tabs (count pill each),
// the FilterBar and the DataTable (Accession no., Patient, Tests, Registered, Time elapsed, Status, row menu) with a pager total. Display only:
// the columns are those OrderSummary carries; age, sex, assignee and department are not in the contract and are not drawn.
import { useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Card } from '@lims/ui/components/Card';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { resolveFlagAction } from '../server/actions';
import type { Coded, OrderFlag, OrderSummary, PatientSummary, PossibleDuplicate } from '../server/types';
import { errorText, hasPerm } from './format';

type Tab = 'recollection' | 'booking' | 'pre' | 'dup';
type List = 'flags' | 'preRegistered' | 'duplicates';
const EMPTY = { title: 'Nothing pending' };
const patientLabel = (p: PatientSummary) => `${p.patient_code} · ${p.full_name}`;
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kathmandu' });
const clock = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? CLOCK.format(t) : '—'; };
/** Hours and minutes since `iso` (the registration time); a future or bad time shows a dash. */
const elapsed = (iso: string, now = Date.now()) => {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const hit = (q: string | undefined, ...texts: (string | undefined)[]) => !q || texts.some((x) => x?.toLowerCase().includes(q.toLowerCase()));

// one column set for both order lists (a flag row reads its order); numbers right aligned (numeric), accession number in the mono family
function orderColumns<R>(get: (r: R) => OrderSummary | undefined, orderId: (r: R) => string): ColumnDef<R>[] {
  return [
    { id: 'reg', header: 'Accession no.', isRowHeader: true, cell: (r) => <a className="lims-link lims-mono" href={`/frontdesk/orders/${orderId(r)}`}>{get(r)?.registration_no ?? 'Open order'}</a> },
    { id: 'patient', header: 'Patient', cell: (r) => get(r)?.patient_display ?? '—' },
    { id: 'tests', header: 'Tests', numeric: true, cell: (r) => { const o = get(r); return o ? String(o.item_count) : '—'; } },
    { id: 'registered', header: 'Registered', cell: (r) => { const o = get(r); return o ? clock(o.registered_at) : '—'; } },
    { id: 'elapsed', header: 'Time elapsed', numeric: true, cell: (r) => { const o = get(r); return o ? elapsed(o.registered_at) : '—'; } },
  ];
}

export function FrontdeskWorklist({ flags, orders, preRegistered, duplicates, resolutions, permissions, failed = [] }: { flags: readonly OrderFlag[]; orders: readonly OrderSummary[]; preRegistered: readonly OrderSummary[]; duplicates: readonly PossibleDuplicate[]; resolutions: readonly Coded[]; permissions: readonly string[]; failed?: readonly List[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('recollection');
  const [resolving, setResolving] = useState<OrderFlag | null>(null);
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState<FilterValue>({});
  const q = typeof filter['q'] === 'string' ? filter['q'].trim() : undefined;
  const key = useRef(crypto.randomUUID());
  const canResolve = hasPerm(permissions, 'frontdesk.order.edit');
  const canSeeDuplicates = hasPerm(permissions, 'frontdesk.registration.create');
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const openAll = (kind: string) => flags.filter((f) => f.status === 'open' && f.kind === kind);
  const open = (kind: string) => openAll(kind).filter((f) => { const o = byOrder.get(f.order_id); return hit(q, o?.registration_no, o?.patient_display); });
  const arm = (f: OrderFlag) => { key.current = crypto.randomUUID(); setNotice(undefined); setResolving(f); };

  const flagColumns = orderColumns<OrderFlag>((f) => byOrder.get(f.order_id), (f) => f.order_id);
  const preColumns = orderColumns<OrderSummary>((o) => o, (o) => o.id);
  const dupColumns: ColumnDef<PossibleDuplicate>[] = [
    { id: 'patient', header: 'New patient', isRowHeader: true, cell: (d) => <a className="lims-link" href={`/frontdesk/patients/${d.patient.id}`}>{patientLabel(d.patient)}</a> },
    { id: 'phone', header: 'Phone', cell: (d) => d.patient.phone_masked },
    { id: 'candidates', header: 'Possible matches', cell: (d) => <ul>{d.candidates.map((c) => <li key={c.id}><a className="lims-link" href={`/frontdesk/patients/${c.id}`}>{patientLabel(c)}</a> {c.phone_masked}</li>)}</ul> },
  ];

  // T0D-UILIST-2 (LD-353 rules 5, 6): a failed list keeps its header row and shows the ErrorState (Retry) in the table body, not a banner instead of the table
  const err = (l: List) => (failed.includes(l) ? { error: { title: 'This list could not be loaded.', onRetry: () => router.refresh() } } : {});
  // the row menu (mock: one IconButton per row) holds Open order and, with frontdesk.order.edit, Resolve (was a Resolve button in the row)
  const flagActions = () => [{ id: 'open', label: 'Open order' }, ...(canResolve ? [{ id: 'resolve', label: 'Resolve' }] : [])];
  const flagTable = (kind: string, caption: string) => {
    const rows = open(kind);
    return (
      <DataTable
        caption={caption}
        columns={flagColumns}
        rows={rows}
        total={rows.length}
        getRowId={(f) => f.id}
        emptyState={EMPTY}
        onRowAction={(f) => router.push(`/frontdesk/orders/${f.order_id}`)}
        rowStatus={(f) => { const o = byOrder.get(f.order_id); return o ? { kind: 'order', status: o.status } : undefined; }}
        rowActions={flagActions}
        onRowActionMenu={(f, a) => (a === 'resolve' ? arm(f) : router.push(`/frontdesk/orders/${f.order_id}`))}
        {...err('flags')}
      />
    );
  };
  const pre = preRegistered.filter((o) => hit(q, o.registration_no, o.patient_display));
  const dups = duplicates.filter((d) => hit(q, d.patient.patient_code, d.patient.full_name));

  // R on a focused row resolves it. Capture phase: runs before the grid's type-ahead can move focus.
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== 'r' || e.ctrlKey || e.metaKey || e.altKey || !canResolve || (tab !== 'recollection' && tab !== 'booking')) return;
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const id = t.closest('[data-row-id]')?.getAttribute('data-row-id');
    const f = flags.find((x) => x.id === id);
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    arm(f);
  };

  // count pill on every tab, 0 shown (LD-140); the count is the whole list, not the filtered rows
  const tabs = [
    { id: 'recollection', label: 'Recollection needed', count: openAll('recollection_required').length },
    { id: 'booking', label: 'Booking cancelled after registration', count: openAll('booking_cancelled_after_registration').length },
    { id: 'pre', label: 'Pre-registered today', count: preRegistered.length },
    ...(canSeeDuplicates ? [{ id: 'dup', label: 'Possible duplicates created today', count: duplicates.length }] : []),
  ];

  return (
    <section aria-label="Front-desk worklist" onKeyDownCapture={onKeyDownCapture}>
      <PageHeader
        title="Front-desk worklist"
        helpKey="frontdesk.worklist"
        caption="Orders and patients that need the front desk today"
        actions={<a className="lims-btn lims-btn-primary" href="/frontdesk/registrations/new">New registration</a>}
      />
      {notice ? <div role="alert"><Banner tone="danger" title={notice} /></div> : null}
      <Card>
        <Tabs items={tabs} selectedId={tab} onChange={(id) => setTab(id as Tab)} aria-label="Worklist">
          <FilterBar
            filters={[{ id: 'q', label: 'Filter by name or accession no.', kind: 'text', maxLength: 64 }]}
            value={filter}
            onChange={setFilter}
            onReset={() => setFilter({})}
            resetLabel="Clear filters"
          />
          {tab === 'recollection' ? flagTable('recollection_required', 'Recollection needed') : null}
          {tab === 'booking' ? flagTable('booking_cancelled_after_registration', 'Booking cancelled after registration') : null}
          {tab === 'pre' ? (
            <DataTable
              caption="Pre-registered today"
              columns={preColumns}
              rows={pre}
              total={pre.length}
              getRowId={(o) => o.id}
              emptyState={EMPTY}
              onRowAction={(o) => router.push(`/frontdesk/orders/${o.id}`)}
              rowStatus={(o) => ({ kind: 'order', status: o.status })}
              rowActions={() => [{ id: 'open', label: 'Open order' }]}
              onRowActionMenu={(o) => router.push(`/frontdesk/orders/${o.id}`)}
              {...err('preRegistered')}
            />
          ) : null}
          {tab === 'dup' && canSeeDuplicates ? <DataTable caption="Possible duplicates created today" columns={dupColumns} rows={dups} total={dups.length} getRowId={(d) => d.patient.id} emptyState={EMPTY} onRowAction={(d) => router.push(`/frontdesk/patients/${d.patient.id}`)} {...err('duplicates')} /> : null}
        </Tabs>
      </Card>

      <ConfirmDialog
        key={key.current}
        title="Resolve flag"
        isOpen={resolving !== null}
        confirmLabel="Resolve"
        onCancel={() => setResolving(null)}
        requireReason={{ codedSet: 'frontdesk.flag_resolutions', options: resolutions }}
        body={<p>Choose how this flag was resolved.</p>}
        onConfirm={async ({ reasonCode }) => {
          if (!resolving || !reasonCode) return;
          const r = await resolveFlagAction(resolving.id, resolving.version, reasonCode, key.current);
          setResolving(null);
          if (r.ok) { toast.show({ tone: 'success', title: 'Flag resolved.' }); router.refresh(); } else setNotice(errorText(r.code, r.status));
        }}
      />
    </section>
  );
}
