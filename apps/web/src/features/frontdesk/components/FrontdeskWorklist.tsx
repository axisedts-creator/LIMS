'use client';
// 04-UI-UX §6 Front-desk worklist: tabs Recollection needed / Booking cancelled after registration / Pre-registered today / Possible duplicates
// created today (F26, registration.create only). DataTable keys: ↑/↓ rows, Enter opens the order, R resolves the focused flag row.
import { useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { resolveFlagAction } from '../server/actions';
import type { Coded, OrderFlag, OrderSummary, PatientSummary, PossibleDuplicate } from '../server/types';
import { Ad, errorText, hasPerm, humanize } from './format';

type Tab = 'recollection' | 'booking' | 'pre' | 'dup';
type List = 'flags' | 'preRegistered' | 'duplicates';
const EMPTY = { title: 'Nothing pending' };
const patientLabel = (p: PatientSummary) => `${p.patient_code} · ${p.full_name}`;

export function FrontdeskWorklist({ flags, orders, preRegistered, duplicates, resolutions, permissions, failed = [] }: { flags: readonly OrderFlag[]; orders: readonly OrderSummary[]; preRegistered: readonly OrderSummary[]; duplicates: readonly PossibleDuplicate[]; resolutions: readonly Coded[]; permissions: readonly string[]; failed?: readonly List[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('recollection');
  const [resolving, setResolving] = useState<OrderFlag | null>(null);
  const [notice, setNotice] = useState<string>();
  const key = useRef(crypto.randomUUID());
  const canResolve = hasPerm(permissions, 'frontdesk.order.edit');
  const canSeeDuplicates = hasPerm(permissions, 'frontdesk.registration.create');
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const open = (kind: string) => flags.filter((f) => f.status === 'open' && f.kind === kind);
  const arm = (f: OrderFlag) => { key.current = crypto.randomUUID(); setNotice(undefined); setResolving(f); };

  const flagColumns: ColumnDef<OrderFlag>[] = [
    { id: 'reg', header: 'Registration no', isRowHeader: true, cell: (f) => <a className="lims-link" href={`/frontdesk/orders/${f.order_id}`}>{byOrder.get(f.order_id)?.registration_no ?? 'Open order'}</a> },
    { id: 'patient', header: 'Patient', cell: (f) => byOrder.get(f.order_id)?.patient_display ?? '—' },
    { id: 'created', header: 'Created', cell: (f) => <Ad value={f.created_at} withTime /> },
    { id: 'actions', header: 'Actions', cell: (f) => (canResolve ? <Button size="sm" onPress={() => arm(f)}>Resolve</Button> : null) },
  ];
  const preColumns: ColumnDef<OrderSummary>[] = [
    { id: 'reg', header: 'Registration no', isRowHeader: true, cell: (o) => <a className="lims-link" href={`/frontdesk/orders/${o.id}`}>{o.registration_no}</a> },
    { id: 'patient', header: 'Patient', cell: (o) => o.patient_display },
    { id: 'source', header: 'Source', cell: (o) => humanize(o.source) },
  ];
  const dupColumns: ColumnDef<PossibleDuplicate>[] = [
    { id: 'patient', header: 'New patient', isRowHeader: true, cell: (d) => <a className="lims-link" href={`/frontdesk/patients/${d.patient.id}`}>{patientLabel(d.patient)}</a> },
    { id: 'phone', header: 'Phone', cell: (d) => d.patient.phone_masked },
    { id: 'candidates', header: 'Possible matches', cell: (d) => <ul>{d.candidates.map((c) => <li key={c.id}><a className="lims-link" href={`/frontdesk/patients/${c.id}`}>{patientLabel(c)}</a> {c.phone_masked}</li>)}</ul> },
  ];

  const loadFailed = () => <Banner tone="danger" title="This list could not be loaded." action={{ label: 'Try again', onPress: () => router.refresh() }} />;
  const flagTable = (kind: string, caption: string) => (failed.includes('flags') ? loadFailed() : <DataTable caption={caption} columns={flagColumns} rows={open(kind)} getRowId={(f) => f.id} emptyState={EMPTY} onRowAction={(f) => router.push(`/frontdesk/orders/${f.order_id}`)} />);

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

  const tabs = [
    { id: 'recollection', label: 'Recollection needed' },
    { id: 'booking', label: 'Booking cancelled after registration' },
    { id: 'pre', label: 'Pre-registered today' },
    ...(canSeeDuplicates ? [{ id: 'dup', label: 'Possible duplicates created today' }] : []),
  ];

  return (
    <section aria-label="Front-desk worklist" onKeyDownCapture={onKeyDownCapture}>
      <PageHeader title="Front-desk worklist" helpKey="frontdesk.worklist" />
      {notice ? <div role="alert"><Banner tone="danger" title={notice} /></div> : null}
      <Tabs items={tabs} selectedId={tab} onChange={(id) => setTab(id as Tab)} aria-label="Worklist">
        {tab === 'recollection' ? flagTable('recollection_required', 'Recollection needed') : null}
        {tab === 'booking' ? flagTable('booking_cancelled_after_registration', 'Booking cancelled after registration') : null}
        {tab === 'pre' ? (failed.includes('preRegistered') ? loadFailed() : <DataTable caption="Pre-registered today" columns={preColumns} rows={preRegistered} getRowId={(o) => o.id} emptyState={EMPTY} onRowAction={(o) => router.push(`/frontdesk/orders/${o.id}`)} />) : null}
        {tab === 'dup' && canSeeDuplicates ? (failed.includes('duplicates') ? loadFailed() : <DataTable caption="Possible duplicates created today" columns={dupColumns} rows={duplicates} getRowId={(d) => d.patient.id} emptyState={EMPTY} onRowAction={(d) => router.push(`/frontdesk/patients/${d.patient.id}`)} />) : null}
      </Tabs>

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
