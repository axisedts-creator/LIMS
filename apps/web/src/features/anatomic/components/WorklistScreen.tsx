'use client';
// 04-UI-UX §4.1 Worklist: PageHeader → lookup row (BarcodeInput) → Tabs → FilterBar → DataTable. AC-13.1 (queues, server order), AC-13.4 (scanner lookup).
// LD-140 (2026-11-13, binding): kit components and token class names only — no hex colours, pixel radii or inline style objects; no page actions, so no
// primary button; every status shows tone, icon and word (see common.tsx Chip).
// The scanned value is never put in a URL, a router call or a log (REQ-SEC-098): it goes to the lookup server action's POST body only.
import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import type { EmptyStateProps } from '@lims/ui/components/EmptyState';
import { FilterBar,type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { lookupLabelAction } from '../server/actions';
import { UUID_RE, type CaseSummary, type Queue } from '../server/types';
import { FlagChips, KIND_LABEL, StatusLabel, UrgentChip, usePageShortcuts, When } from './common';

const PAGE_ID = 'staff.anatomic.worklist';
const LABEL_RE = /^[A-Z0-9-]{1,32}$/;
const C5_BARCODE_RE = /^[A-Z0-9]{1,20}$/; // C5 specimen barcode charset (04-UI-UX §2)

const QUEUE_TABS: readonly { id: Queue; label: string }[] = [
  { id: 'to_accession', label: 'To accession' }, { id: 'grossing', label: 'Grossing' }, { id: 'bench', label: 'Bench' }, { id: 'reporting', label: 'Reporting' },
  { id: 'awaiting_lab', label: 'Awaiting lab approval' }, { id: 'signed_out', label: 'Signed out' }, { id: 'cancelled', label: 'Cancelled' }, { id: 'all', label: 'All' },
];
/** Work queues are "empty" rather than "filtered to nothing": their empty state carries no Reset (04-UI-UX §4.1). */
const EMPTY: Partial<Record<Queue, EmptyStateProps>> = {
  to_accession: { title: 'Nothing to accession', body: 'New cases appear here when the lab receives a histology, cytology or molecular specimen.' },
  grossing: { title: 'No cases waiting for gross description.' },
  bench: { title: 'No slides or stain orders pending.' },
  reporting: { title: 'No cases ready for reporting.' },
};
const NO_MATCH = 'No cases match these filters.';
const MSG = {
  notFound: 'No case, block or slide with this label.',
  specimen: 'This is a sample barcode. Receive samples in Lab → Specimens; pathology cases appear here after receipt.',
  denied: 'You do not have permission to look up cases.',
  failed: 'The lookup failed. Try again.',
};

const FILTER_KEYS = ['case_kind', 'centre_id', 'priority', 'assigned_pathologist', 'received_at_from', 'received_at_to'] as const;
const csv = (v: string | null) => (v ? v.split(',').filter(Boolean) : undefined);
// [CONV] tenant timezone is not available to the client yet: day bounds use the browser's local midnight (same as C7 MessagesList).
const startOfDay = (isoDate: string, plusDays = 0) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y!, m! - 1, d! + plusDays).toISOString();
};
const localDate = (iso: string | null, minusDays = 0) => {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() - minusDays);
  return d.toLocaleDateString('en-CA');
};

export interface WorklistScreenProps {
  queue: Queue;
  cases: readonly CaseSummary[];
  /** Opaque cursor of the next page (absent on the last page). */
  nextCursor?: string;
  /** Held for symmetry with the case workspace; the worklist has no permission-gated page actions. */
  permissions: readonly string[];
}

export function WorklistScreen({ queue, cases, nextCursor }: WorklistScreenProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const lookupBox = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const [lookupError, setLookupError] = useState<string>();

  usePageShortcuts(PAGE_ID, [{ key: 'Alt+F', description: 'Find a case: move to the lookup field', run: () => lookupBox.current?.querySelector('input')?.focus() }], []);

  const go = (params: Record<string, string | undefined>) => {
    const p = new URLSearchParams({ queue });
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    router.push(`/anatomic?${p.toString()}`);
  };
  const current = () => Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k) ?? undefined]));

  const onScan = async (label: string) => {
    if (busy.current || !LABEL_RE.test(label)) return;
    busy.current = true;
    setLookupError(undefined);
    try {
      const r = await lookupLabelAction(label);
      if (r.ok) {
        const { object_kind: kind, case_id: caseId, block_id: blockId, slide_id: slideId } = r.data;
        if (!UUID_RE.test(caseId)) return setLookupError(MSG.failed);
        const base = `/anatomic/cases/${caseId}`;
        if (kind === 'block' && blockId && UUID_RE.test(blockId)) router.push(`${base}?block=${blockId}`);
        else if (kind === 'slide' && slideId && UUID_RE.test(slideId)) router.push(`${base}?slide=${slideId}`);
        else router.push(base);
      } else setLookupError(r.status === 404 ? (C5_BARCODE_RE.test(label) ? MSG.specimen : MSG.notFound) : r.status === 403 ? MSG.denied : MSG.failed);
    } catch {
      setLookupError(MSG.failed);
    } finally {
      busy.current = false;
    }
  };

  // Filters (04-UI-UX §4.1). Centre options come from the centres on screen until the C0 centres read is wired through the BFF (open point).
  const selectedCentres = csv(sp.get('centre_id')) ?? [];
  const centreIds = [...new Set([...cases.map((c) => c.centre_id), ...selectedCentres])];
  const filters: FilterDef[] = [
    { id: 'case_kind', label: 'Case kind', kind: 'select', multiple: true, options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) },
    ...(centreIds.length ? [{ id: 'centre_id', label: 'Centre', kind: 'select', multiple: true, options: centreIds.map((id) => ({ value: id, label: `Centre ${id.slice(0, 8)}` })) } satisfies FilterDef] : []),
    { id: 'priority', label: 'Priority', kind: 'select', options: [{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }] },
    { id: 'assigned_pathologist', label: 'Pathologist', kind: 'select', options: [{ value: 'me', label: 'Me' }, { value: 'any', label: 'Anyone' }] },
    { id: 'received', label: 'Received', kind: 'date_range' },
  ];
  const from = localDate(sp.get('received_at_from'));
  const to = localDate(sp.get('received_at_to'), 1);
  const filterValue: FilterValue = {
    case_kind: csv(sp.get('case_kind')),
    centre_id: selectedCentres.length ? selectedCentres : undefined,
    priority: sp.get('priority') ?? undefined,
    assigned_pathologist: sp.get('assigned_pathologist') === 'me' ? 'me' : undefined,
    received: from && to ? [from, to] : undefined,
  };
  const onFilters = (v: FilterValue) => {
    const list = (x: FilterValue[string]) => (Array.isArray(x) && x.length ? x.join(',') : undefined);
    const one = (x: FilterValue[string]) => (typeof x === 'string' ? x : undefined);
    const range = Array.isArray(v['received']) && v['received'].length === 2 ? (v['received'] as string[]) : undefined;
    go({
      case_kind: list(v['case_kind']),
      centre_id: list(v['centre_id']),
      priority: one(v['priority']),
      assigned_pathologist: one(v['assigned_pathologist']) === 'me' ? 'me' : undefined,
      ...(range ? { received_at_from: startOfDay(range[0]!), received_at_to: startOfDay(range[1]!, 1) } : {}),
      ...(sp.get('sort') ? { sort: sp.get('sort') ?? undefined } : {}),
    });
  };
  const hasFilters = Object.values(current()).some(Boolean);
  const workEmpty = cases.length === 0 && EMPTY[queue] !== undefined && !hasFilters;

  const columns: ColumnDef<CaseSummary>[] = [
    {
      id: 'accession', header: 'Accession',
      cell: (c) => (
        <a className="lims-link lims-mono" href={`/anatomic/cases/${c.id}`}>
          {c.accession_no ?? <span className="lims-description">Not accessioned</span>}
        </a>
      ),
    },
    {
      id: 'patient', header: 'Patient', isRowHeader: true,
      cell: (c) =>
        c.patient ? (
          <div>
            <div>{c.patient.display_name}</div>
            <div className="lims-description">{c.patient.age_text} / {c.patient.sex} · {c.patient.patient_code}</div>
          </div>
        ) : (
          <>—</>
        ),
    },
    { id: 'kind', header: 'Kind', hideBelow: 'md', cell: (c) => <StatusChip kind="generic" status={c.case_kind} tone="neutral" label={KIND_LABEL[c.case_kind] ?? c.case_kind} /> },
    {
      id: 'tests', header: 'Tests', hideBelow: 'lg',
      cell: (c) => {
        const t = c.test_names.join(', ');
        return <span title={t}>{t.length > 40 ? `${t.slice(0, 39)}…` : t}</span>;
      },
    },
    { id: 'parts', header: 'Parts', hideBelow: 'lg', align: 'end', cell: (c) => c.part_count },
    { id: 'received', header: 'Received', cell: (c) => <When value={c.received_at} time /> },
    { id: 'priority', header: 'Priority', cell: (c) => (c.priority === 'urgent' ? <UrgentChip /> : null) },
    {
      id: 'status', header: 'Status',
      cell: (c) => (
        <div>
          <StatusLabel status={c.status} />
          <FlagChips flags={c.flags} />
        </div>
      ),
    },
    { id: 'pathologist', header: 'Pathologist', hideBelow: 'xl', cell: (c) => c.assigned_pathologist?.display_name ?? '—' },
  ];

  const open = (c: CaseSummary) => router.push(`/anatomic/cases/${c.id}`);
  const empty = EMPTY[queue] ?? { title: NO_MATCH };
  const paged = nextCursor !== undefined || sp.get('cursor') !== null;

  return (
    <>
      <PageHeader title="Pathology cases" helpKey="anatomic.worklist" />
      <div ref={lookupBox}>
        <BarcodeInput
          label="Scan or type an accession, block or slide label"
          name="label"
          pattern={/^[A-Z0-9-]{1,32}$/}
          submitKeys={['Enter', 'Tab']}
          clearAfterScan
          allowManual
          onScan={(v) => void onScan(v)}
          {...(lookupError ? { error: lookupError } : {})}
        />
      </div>
      <Tabs
        aria-label="Queues"
        items={QUEUE_TABS.map((t) => ({ id: t.id, label: t.label, ...(t.id === queue ? { badge: nextCursor ? `${cases.length}+` : String(cases.length) } : {}) }))}
        selectedId={queue}
        onChange={(id) => id !== queue && router.push(`/anatomic?${new URLSearchParams({ queue: id, ...Object.fromEntries(Object.entries(current()).filter(([, v]) => v)) } as Record<string, string>).toString()}`)}
      >
        {workEmpty ? null : <FilterBar filters={filters} value={filterValue} onChange={onFilters} onReset={() => go({})} />}
        <DataTable
          caption="Pathology cases"
          columns={columns}
          rows={cases}
          getRowId={(c) => c.id}
          density="compact"
          onRowAction={open}
          emptyState={empty}
          {...(paged ? { page: { hasNext: nextCursor !== undefined, hasPrevious: sp.get('cursor') !== null, onNext: () => go({ ...current(), cursor: nextCursor }), onPrevious: () => router.back(), limit: 50 } } : {})}
        />
      </Tabs>
    </>
  );
}
