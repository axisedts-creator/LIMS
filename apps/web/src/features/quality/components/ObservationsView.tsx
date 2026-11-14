'use client';
// 04-UI-UX §2.5 Unassigned QC: raw control id / lot / level as the instrument sent them, a plain-language status and, with quality.qc.manage, the fix for that status.
import { useRouter } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { UNASSIGNED } from '../format';
import type { UnassignedObservation } from '../types';
import { qs } from './Shared';

type Iso = DateTextProps['value'];
const STATUS_OPTIONS = Object.entries(UNASSIGNED).map(([value, { label }]) => ({ value, label }));
const FIX_LABEL = { maps: 'Create control map', plans: 'Create QC plan', targets: 'Add target' } as const;

export function ObservationsView({ rows, next, hasPrevious, sp, canManage, instruments }: {
  rows: UnassignedObservation[]; next?: string; hasPrevious: boolean; sp: Record<string, string>; canManage: boolean; instruments: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const go = (patch: Record<string, string | undefined>) => router.push(`/quality/observations${qs({ ...sp, cursor: undefined, ...patch })}`);
  const filter: FilterValue = { status: sp['status']?.split(',') };

  /** Set-up forms are pre-filled through the URL (instrument + the raw id / lot), never through state. */
  const fixHref = (r: UnassignedObservation, fix: keyof typeof FIX_LABEL) => `/quality/setup/${fix}${qs({ instrument_id: r.instrument_id, ...(fix === 'maps' ? { control_id: r.control_id_raw, control_lot: r.control_lot_raw } : {}) })}`;

  const columns: ColumnDef<UnassignedObservation>[] = [
    { id: 'at', header: 'Observed at', isRowHeader: true, cell: (r) => <DateText value={r.observed_at as Iso} withTime /> },
    { id: 'instrument', header: 'Instrument', cell: (r) => instruments[r.instrument_id] ?? r.instrument_id.slice(0, 8) },
    { id: 'analyte', header: 'Analyte', cell: (r) => (r.status === 'unmapped_analyte' ? 'Not mapped in catalog' : '—') },
    { id: 'control', header: 'Control id', cell: (r) => r.control_id_raw },
    { id: 'lot', header: 'Lot', cell: (r) => r.control_lot_raw },
    { id: 'level', header: 'Level', hideBelow: 'xl', cell: (r) => r.control_level_raw },
    { id: 'value', header: 'Value', align: 'end', cell: (r) => `${r.value}${r.unit_code ? ` ${r.unit_code}` : ''}` },
    { id: 'status', header: 'Status', cell: (r) => <StatusChip kind="generic" status={r.status} label={UNASSIGNED[r.status]?.label ?? 'Not assigned'} tone="warning" /> },
    {
      id: 'fix', header: 'Fix',
      cell: (r) => {
        if (r.status === 'unmapped_analyte') return 'Map the instrument code in Instruments › Code maps';
        const fix = UNASSIGNED[r.status]?.fix;
        return fix && canManage ? <a className="lims-btn lims-btn-secondary lims-btn-sm" href={fixHref(r, fix)}>{FIX_LABEL[fix]}</a> : '—';
      },
    },
  ];

  return (
    <>
      <PageHeader title="Unassigned QC" helpKey="quality.observations" />
      <FilterBar
        filters={[{ id: 'status', label: 'Status', kind: 'select', multiple: true, options: STATUS_OPTIONS }]}
        value={filter}
        onChange={(v) => go({ status: Array.isArray(v['status']) ? v['status'].join(',') : undefined })}
        onReset={() => router.push('/quality/observations')}
      />
      <DataTable<UnassignedObservation>
        columns={columns} rows={rows} getRowId={(r) => r.id} density="compact" caption="Unassigned QC observations"
        emptyState={{ title: 'All QC values are assigned.' }}
        {...(next || hasPrevious ? { page: { hasNext: !!next, hasPrevious, onNext: () => next && go({ cursor: next }), onPrevious: () => router.back(), limit: 50 } } : {})}
      />
    </>
  );
}
