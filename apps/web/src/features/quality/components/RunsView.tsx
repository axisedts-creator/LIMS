'use client';
// 04-UI-UX §2.2 QC runs. LD-140: @lims/ui only. Sort is run time descending only (the API offers nothing else).
import { useRouter } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { MODE, NEEDS_ACTION, OUTCOME, RUN_STATUS, rulesText } from '../format';
import type { RunSummary } from '../types';
import { qs } from './Shared';

type Iso = DateTextProps['value'];
const opts = (m: Record<string, { label: string }>) => Object.entries(m).map(([value, { label }]) => ({ value, label }));

export interface PlanLabels { [planId: string]: { instrument: string; analyte: string } | undefined }

export function RunsView({ rows, next, hasPrevious, sp, labels }: { rows: RunSummary[]; next?: string; hasPrevious: boolean; sp: Record<string, string>; labels: PlanLabels }) {
  const router = useRouter();
  const go = (patch: Record<string, string | undefined>) => router.push(`/quality/runs${qs({ ...sp, cursor: undefined, ...patch })}`);
  const filter: FilterValue = { status: sp['status'], outcome: sp['outcome'], needs_action: sp['needs_action'] };

  const columns: ColumnDef<RunSummary>[] = [
    { id: 'run_at', header: 'Run time', isRowHeader: true, cell: (r) => <a href={`/quality/qc-runs/${r.id}`}><DateText value={r.run_at as Iso} withTime /></a> },
    { id: 'instrument', header: 'Instrument', cell: (r) => labels[r.plan_id]?.instrument ?? '—' },
    { id: 'analyte', header: 'Analyte', cell: (r) => labels[r.plan_id]?.analyte ?? '—' },
    { id: 'n', header: 'N', align: 'end', hideBelow: 'xl', cell: (r) => String(r.controls_per_run) },
    { id: 'mode', header: 'Mode', hideBelow: 'xl', cell: (r) => MODE[r.rule_mode] ?? r.rule_mode },
    { id: 'obs', header: 'Observations', align: 'end', cell: (r) => `${r.observation_count} / ${r.controls_per_run}` },
    {
      id: 'outcome', header: 'Outcome',
      cell: (r) => {
        const c = r.outcome ? OUTCOME[r.outcome] : RUN_STATUS[r.status];
        return <StatusChip kind="generic" status={r.outcome ?? r.status} label={c.label} tone={c.tone} />;
      },
    },
    { id: 'rules', header: 'Rules', cell: (r) => rulesText(r.rules_violated) },
    { id: 'needs', header: 'Needs action', cell: (r) => (r.needs_action && r.needs_action_reason ? NEEDS_ACTION[r.needs_action_reason] ?? '—' : '—') },
    { id: 'closed', header: 'Closed at', hideBelow: 'lg', cell: (r) => (r.closed_at ? <DateText value={r.closed_at as Iso} withTime /> : '—') },
  ];

  return (
    <>
      <PageHeader title="QC runs" helpKey="quality.runs" />
      <FilterBar
        filters={[
          { id: 'status', label: 'Status', kind: 'select', options: opts(RUN_STATUS) },
          { id: 'outcome', label: 'Outcome', kind: 'select', options: opts(OUTCOME) },
          // T0D-UILIST-1 (LD-353 template 1): the loose "Needs action" checkbox is a field of the one FilterBar.
          { id: 'needs_action', label: 'Needs action', kind: 'select', options: [{ value: 'true', label: 'Needs action' }] },
        ]}
        value={filter}
        onChange={(v) => { const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined); go({ status: s('status'), outcome: s('outcome'), needs_action: s('needs_action') }); }}
        onReset={() => router.push('/quality/runs')}
      />
      <DataTable<RunSummary>
        columns={columns} rows={rows} getRowId={(r) => r.id} density="compact" caption="QC runs"
        onRowAction={(r) => router.push(`/quality/qc-runs/${r.id}`)}
        emptyState={{ title: 'No QC runs match these filters.' }}
        {...(next || hasPrevious ? { page: { hasNext: !!next, hasPrevious, onNext: () => next && go({ cursor: next }), onPrevious: () => router.back(), limit: 50 } } : {})}
      />
    </>
  );
}
