'use client';
// 04-UI-UX §4 / §3.5 record table (AC-08.4–AC-08.6 UI side). LD-140 (2026-11-13): kit DataTable only; every status shows tone, icon and word.
// Instrument-supplied text (codes, raw values) renders as text nodes only (REQ-SEC-121). The barcode is shown (P2) and never put in a URL; the culture tab hides it.
import { DataTable, type ColumnDef, type DataTableProps } from '@lims/ui/components/DataTable';
import type { InstrumentRecordRow } from '../../server/types';
import { Chip, When } from '../common';
import { ACTION_LABEL, RECORD_STATUS, actionsFor, kindText, reasonText, valueText, type RecordAction } from './labels';

export interface RecordTableProps {
  rows: readonly InstrumentRecordRow[];
  caption: string;
  emptyTitle: string;
  /** The culture tab omits the Barcode column and the Assign action. */
  inCulture?: boolean;
  /** micro.culture.work: without it the list is readable and has no row actions. */
  canWork: boolean;
  onAction: (r: InstrumentRecordRow, a: RecordAction) => void;
  page?: DataTableProps<InstrumentRecordRow>['page'];
}

export function RecordTable({ rows, caption, emptyTitle, inCulture = false, canWork, onAction, page }: RecordTableProps) {
  const columns: ColumnDef<InstrumentRecordRow>[] = [
    { id: 'received', header: 'Received', isRowHeader: true, cell: (r) => <When value={r.received_at} time /> },
    { id: 'instrument', header: 'Instrument', cell: (r) => r.instrument_label ?? '—' },
    // the spaces keep "AST" a separate word in the row's text (copy / paste, readers that join the cells)
    { id: 'kind', header: 'Kind', cell: (r) => ` ${kindText(r.record_kind)} ` },
    ...(inCulture ? [] : [{ id: 'barcode', header: 'Barcode', cell: (r: InstrumentRecordRow) => <span className="lims-mono">{r.sample_barcode}</span> }]),
    { id: 'isolate', header: 'Isolate no.', cell: (r) => (r.isolate_seq === undefined ? '—' : String(r.isolate_seq)) },
    { id: 'code', header: 'Code', cell: (r) => r.antibiotic_code_raw ?? r.organism_code_raw ?? '—' },
    { id: 'value', header: 'Value', cell: (r) => valueText(r) },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => {
        const s = Object.hasOwn(RECORD_STATUS, r.match_status) ? RECORD_STATUS[r.match_status]! : { label: 'Unknown', tone: 'neutral' as const };
        return <Chip tone={s.tone} label={s.label} />;
      },
    },
    { id: 'reason', header: 'Reason', cell: (r) => reasonText(r.match_reason) },
  ];
  return (
    <DataTable<InstrumentRecordRow>
      caption={caption}
      density="compact"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      emptyState={{ title: emptyTitle }}
      {...(canWork
        ? {
            rowActions: (r: InstrumentRecordRow) => actionsFor(r, inCulture).map((a) => ({ id: a, label: ACTION_LABEL[a] })),
            onRowActionMenu: (r: InstrumentRecordRow, id: string) => onAction(r, id as RecordAction),
          }
        : {})}
      {...(page ? { page } : {})}
    />
  );
}
