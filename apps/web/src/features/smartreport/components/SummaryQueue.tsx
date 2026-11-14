'use client';
// SR-01 Review queue (04-UI-UX SR-01). Filters, sort and paging are URL navigations (the server page re-reads #27); rows are review-only (AC-14.6).
// Shortcuts are page-level: J/K move row focus, Enter/double-click open SR-02 (DataTable onRowAction), `/` focuses the first filter, `?` lists them.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { KeyboardShortcutsDialog } from '@lims/ui/components/KeyboardShortcutsDialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';

export interface QueueRow {
  id: string; builtAt: string; registrationNo: string; patient: string; centre: string; deranged: number; critical: number;
  band: string; status: string; statusLabel: string; tone: 'info' | 'success' | 'danger' | 'neutral';
}
interface Props {
  rows: QueueRow[]; status: string[]; sort: string; hasPrevious: boolean; next?: string; featureOff: boolean;
  centreId?: string | undefined; hasCritical: boolean; centres: { value: string; label: string }[];
}

const PATH = '/smartreport/summaries';
const STATUS_OPTIONS = [['draft', 'Awaiting review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['superseded', 'Superseded']].map(([value, label]) => ({ value: value!, label: label! }));
const YES_NO = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
const SHORTCUTS = [{ id: 'queue', title: 'Review queue', shortcuts: [
  { keys: 'J', description: 'Next row' }, { keys: 'K', description: 'Previous row' }, { keys: 'Enter', description: 'Open the summary' },
  { keys: '/', description: 'Focus the first filter' }, { keys: '?', description: 'Show keyboard shortcuts' },
] }];
type Iso = DateTextProps['value']; // the API sends validated IsoUtc strings; the plain-JSON view model carries them as string

export function SummaryQueue({ rows, status, sort, hasPrevious, next, featureOff, centreId, hasCritical, centres }: Props) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (k === '?') { e.preventDefault(); setHelp(true); return; }
      if (k === '/') {
        e.preventDefault();
        root.current?.querySelector<HTMLElement>('[role="search"] [role="option"], [role="search"] button, [role="search"] input')?.focus();
        return;
      }
      if (k !== 'j' && k !== 'k') return;
      const list = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? []);
      if (!list.length) return;
      e.preventDefault();
      const at = list.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
      const to = at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + (k === 'j' ? 1 : -1))); // no wrap
      list[to]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /** Navigate to the queue with the given filter; a changed filter always restarts paging. */
  const go = (f: { status: readonly string[]; centreId?: string | undefined; hasCritical: boolean; sort: string; cursor?: string }) => {
    const p = new URLSearchParams();
    if (!(f.status.length === 1 && f.status[0] === 'draft') && f.status.length) p.set('status', f.status.join(','));
    if (f.centreId) p.set('centre_id', f.centreId);
    if (f.hasCritical) p.set('has_critical', 'true');
    if (f.sort !== 'built_at') p.set('sort', f.sort);
    if (f.cursor) p.set('cursor', f.cursor);
    const s = p.toString();
    router.push(s ? `${PATH}?${s}` : PATH);
  };

  const filters: FilterDef[] = [
    { id: 'status', label: 'Status', kind: 'select', multiple: true, options: STATUS_OPTIONS },
    { id: 'centre_id', label: 'Centre', kind: 'select', options: centres },
    { id: 'has_critical', label: 'Critical only', kind: 'select', options: YES_NO },
  ];
  const value: FilterValue = { status, centre_id: centreId, has_critical: hasCritical ? 'true' : 'false' };
  const onChange = (v: FilterValue) => {
    const s = v['status'];
    const c = v['centre_id'];
    go({ status: Array.isArray(s) ? s : ['draft'], centreId: typeof c === 'string' ? c : undefined, hasCritical: v['has_critical'] === 'true', sort });
  };

  const columns: ColumnDef<QueueRow>[] = [
    { id: 'built', header: 'Built', sortKey: 'built_at', isRowHeader: true, cell: (r) => (r.builtAt ? <DateText value={r.builtAt as Iso} withTime /> : '—') },
    { id: 'registration', header: 'Registration no.', cell: (r) => r.registrationNo },
    { id: 'patient', header: 'Patient', cell: (r) => r.patient },
    { id: 'centre', header: 'Centre', cell: (r) => r.centre },
    { id: 'findings', header: 'Findings', cell: (r) => <>{r.deranged} outside range{r.critical > 0 ? <> <Badge tone="critical">Critical</Badge></> : null}</> },
    { id: 'band', header: 'Score band', cell: (r) => r.band },
    { id: 'status', header: 'Status', cell: (r) => <StatusChip kind="generic" status={r.status} label={r.statusLabel} tone={r.tone} /> },
  ];

  return (
    <div ref={root}>
      <PageHeader title="Smart summaries" helpKey="smartreport.queue" />
      {featureOff ? (
        <Banner tone="info" title="Smart report is switched off for this lab.">
          <a href="/admin/settings">Open settings</a>
        </Banner>
      ) : null}
      <FilterBar filters={filters} value={value} onChange={onChange} onReset={() => router.push(PATH)} />
      <DataTable<QueueRow>
        columns={columns} rows={rows} getRowId={(r) => r.id} density="compact" caption="Smart summaries"
        sort={{ value: sort, onChange: (s) => go({ status, centreId, hasCritical, sort: s }) }}
        onRowAction={(r) => router.push(`${PATH}/${encodeURIComponent(r.id)}`)}
        emptyState={{ title: 'No summaries waiting for review.' }}
        page={{ hasNext: !!next, hasPrevious, onNext: () => next && go({ status, centreId, hasCritical, sort, cursor: next }), onPrevious: () => router.back(), limit: 50 }}
      />
      <KeyboardShortcutsDialog isOpen={help} onClose={() => setHelp(false)} groups={SHORTCUTS} />
    </div>
  );
}
