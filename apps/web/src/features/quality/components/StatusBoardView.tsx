'use client';
// 04-UI-UX §2.1 QC status board. LD-140: @lims/ui only; every status shows tone, icon and word. PageShell is supplied by the (staff) layout.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { t } from '@/core/i18n/messages';
import { QC_STATUS } from '../format';
import { pollStatusAction } from '../server/actions';
import type { StatusRow } from '../types';
import { usePolled } from './polling';
import { ChartTable, ConnectionLost, UpdatedAt, qs } from './Shared';

type Iso = DateTextProps['value'];
const STATUS_OPTIONS = (Object.keys(QC_STATUS) as (keyof typeof QC_STATUS)[]).map((s) => ({ value: s, label: QC_STATUS[s].label }));

export function StatusBoardView({ rows, generatedAt, sp, canManage }: { rows: StatusRow[]; generatedAt: string; sp: Record<string, string>; canManage: boolean }) {
  const router = useRouter();
  const { data, updatedAt, lost } = usePolled(rows, generatedAt, () => pollStatusAction(sp), JSON.stringify(sp));
  const count = (s: string) => data.filter((r) => r.status === s).length;
  const out = count('out_of_control');

  // Live region: announces only a change of the out-of-control count, never a plain refresh (04-UI-UX §4).
  const [announce, setAnnounce] = useState('');
  const seen = useRef(out);
  useEffect(() => {
    if (out === seen.current) return;
    seen.current = out;
    setAnnounce(`${out} instrument/analyte pairs out of control`);
  }, [out]);

  const instruments = [...new Map(rows.concat(data).map((r) => [r.instrument_id, r.instrument_label])).entries()].map(([value, label]) => ({ value, label }));
  const filter: FilterValue = { instrument_id: sp['instrument_id'], status: sp['status']?.split(',') };
  const go = (patch: Record<string, string | undefined>) => router.push(`/quality${qs({ ...sp, ...patch })}`);
  const lj = (r: StatusRow) => `/quality/lj${qs({ plan_id: r.plan_id })}`;

  const columns: ColumnDef<StatusRow>[] = [
    { id: 'instrument', header: 'Instrument', isRowHeader: true, cell: (r) => r.instrument_label },
    { id: 'analyte', header: 'Analyte', cell: (r) => r.analyte_code },
    {
      id: 'status', header: 'Status',
      cell: (r) => (
        <>
          <StatusChip kind="generic" status={r.status} label={QC_STATUS[r.status].label} tone={QC_STATUS[r.status].tone} />
          {r.violated_rules.length ? <span>{` · ${r.violated_rules.join(', ')}`}</span> : null}
        </>
      ),
    },
    { id: 'last', header: 'Last in-control QC', hideBelow: 'lg', cell: (r) => (r.last_in_control_run_at ? <DateText value={r.last_in_control_run_at as Iso} withTime /> : '—') },
    {
      id: 'open', header: 'Open failures', align: 'end',
      cell: (r) => {
        const n = r.open_rejected_run_ids.length;
        return n ? <a href={`/quality/runs${qs({ needs_action: 'true', plan_id: r.plan_id })}`}>{n}</a> : '0';
      },
    },
    { id: 'overdue', header: 'QC overdue', cell: (r) => (r.qc_overdue ? <Badge tone="warning">Overdue</Badge> : null) },
    // surrounding spaces keep this count apart from the neighbouring cells in flattened text (copy, search, text-only readers)
    { id: 'patients', header: 'Patients since QC', align: 'end', hideBelow: 'xl', cell: (r) => ` ${r.patient_results_since_last_qc} ` },
    {
      id: 'actions', header: 'Actions',
      cell: (r) => (
        <>
          <a href={lj(r)}>LJ chart</a>
          {' · '}
          <a href={`/quality/runs${qs({ plan_id: r.plan_id })}`}>Runs</a>
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('quality.nav.status')}
        helpKey="quality.status"
        status={<UpdatedAt at={updatedAt} />}
        actions={canManage ? <a className="lims-btn lims-btn-secondary" href="/quality/setup/materials">Set up QC</a> : null}
      />
      <div aria-live="polite" className="lims-visually-hidden">{announce}</div>
      {lost ? <ConnectionLost since={updatedAt} /> : null}
      {out > 0 ? <Banner tone="danger" title={`${out} instrument/analyte pairs are out of control. Patient results are held in Lab until released.`} /> : null}
      <FilterBar
        filters={[
          ...(instruments.length ? [{ id: 'instrument_id', label: 'Instrument', kind: 'select' as const, options: instruments }] : []),
          { id: 'status', label: 'Status', kind: 'select' as const, multiple: true, options: STATUS_OPTIONS },
        ]}
        value={filter}
        onChange={(v) => go({ instrument_id: typeof v['instrument_id'] === 'string' ? v['instrument_id'] : undefined, status: Array.isArray(v['status']) ? v['status'].join(',') : undefined })}
        onReset={() => router.push('/quality')}
      />
      <Checkbox label="Overdue only" isSelected={sp['overdue_only'] === 'true'} onChange={(on) => go({ overdue_only: on ? 'true' : undefined })} />
      {/* T0D-UIDASH-1, LD-353 template 5: tiles and the bar count the rows already on the screen (no new operation) */}
      <StatTileRow>
        <StatTile data-stat-tone="green" label="In control" value={` ${count('in_control')}`} />
        <StatTile data-stat-tone="amber" label="Warning" value={` ${count('warning')}`} />
        <StatTile data-stat-tone="red" label="Out of control" value={` ${out}`} />
        <StatTile data-stat-tone="blue" label="QC overdue" value={` ${data.filter((r) => r.qc_overdue).length}`} />
      </StatTileRow>
      <DataTable<StatusRow>
        columns={columns} rows={data} getRowId={(r) => r.plan_id} density="compact" caption="QC status by instrument and analyte"
        onRowAction={(r) => router.push(lj(r))}
        emptyState={{
          title: 'No QC plans yet',
          body: 'Set up control materials, a QC plan and targets to start evaluating QC.',
          ...(canManage ? { action: { label: 'Set up QC', onPress: () => router.push('/quality/setup/materials') } } : {}),
        }}
      />
      {/* T0D-BUILD-5: the chart data is now a kit DataTable, so the card sits below the rows table to keep that the page's first table (as in RunsView) */}
      <ChartCard title="Pairs by status" isEmpty={data.length === 0}>
        <ChartTable title="Pairs by status" label="Status" valueHeader="Pairs" rows={STATUS_OPTIONS.map((o) => ({ label: o.label, value: count(o.value) }))} />
      </ChartCard>
    </>
  );
}
