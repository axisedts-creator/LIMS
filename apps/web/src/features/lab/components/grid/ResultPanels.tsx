// C5.T-20 — history side panel (Drawer, F2) and trend dialog (TimeSeriesChart, F3), 04-UI-UX §3.7. Server data is shown as plain text (S-14).
// The panels are given ready data: the grid loads first and opens after, so an open panel is never half empty.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { FlagBadge, type ResultFlag } from '@lims/ui/components/FlagBadge';
import { TimeSeriesChart } from '@lims/ui/components/TimeSeriesChart';
import type { HistoryRow, TrendResponse } from '../../server/types';
import { formatDateTime } from './resultModel';

const MAX_HISTORY = 5;
const MIN_POINTS = 2;
const year = (iso: string) => formatDateTime(iso).slice(6, 10);
const dayTime = (iso: string) => formatDateTime(iso).replace(/^(\d\d\/\d\d)\/\d{4}/, '$1');
const NO_HISTORY = 'No previous results for this patient.';
const HISTORY_COLS: ColumnDef<HistoryRow>[] = [
  { id: 'date', header: 'Date', isRowHeader: true, cell: (r) => <time dateTime={r.approved_at}>{dayTime(r.approved_at)}</time> },
  { id: 'value', header: 'Value', numeric: true, cell: (r) => r.value },
  { id: 'unit', header: 'Unit', cell: (r) => r.unit_code ?? '' },
  { id: 'flag', header: 'Flag', cell: (r) => (r.flag ? <FlagBadge flag={r.flag as ResultFlag} /> : null) },
  { id: 'version', header: 'Version', cell: (r) => `v${r.version_no}` },
];
type Point = TrendResponse['points'][number];
const POINT_COLS: ColumnDef<Point>[] = [
  { id: 'date', header: 'Date', isRowHeader: true, cell: (p) => formatDateTime(p.at) },
  { id: 'value', header: 'Value', numeric: true, cell: (p) => p.value },
  { id: 'unit', header: 'Unit', cell: (p) => p.unit_code ?? '' },
];

/** Last 5 approved results, newest first. The year is a group heading so a row reads "08/11 10:45 AM". */
export function HistoryPanel({ analyte, rows, onClose }: { analyte: string; rows: readonly HistoryRow[]; onClose: () => void }) {
  const list = [...rows].sort((a, b) => Date.parse(b.approved_at) - Date.parse(a.approved_at)).slice(0, MAX_HISTORY);
  const groups = [...new Set(list.map((r) => year(r.approved_at)))];
  return (
    <Drawer title={`History — ${analyte}`} isOpen onClose={onClose}>
      {/* T0D-UIX-3 (LD-442): kit DataTable, one per year group (the year is the group heading); an empty history keeps the header (LD-353 rule 5) */}
      {list.length ? groups.map((y) => (
        <section key={y} aria-label={y}>
          <p className="lims-card-title">{y}</p>
          <DataTable caption={`Last approved results of ${analyte}, ${y}`} rows={list.filter((r) => year(r.approved_at) === y)} getRowId={(r) => r.result_id} emptyState={{ title: NO_HISTORY }} columns={HISTORY_COLS} />
        </section>
      )) : <DataTable caption={`Last approved results of ${analyte}`} rows={[]} getRowId={(r) => r.result_id} emptyState={{ title: NO_HISTORY }} columns={HISTORY_COLS} />}
    </Drawer>
  );
}

/** Same-unit points are plotted; the others are listed under "Not plotted (different unit)". `unit` = the current result's unit (else the newest point's). */
export function TrendDialog({ analyte, unit, data, onClose }: { analyte: string; unit?: string | undefined; data: TrendResponse; onClose: () => void }) {
  const [asTable, setAsTable] = useState(false);
  const pts = [...data.points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const u = unit ?? data.reference_band?.unit_code ?? pts[pts.length - 1]?.unit_code;
  const plotted = pts.filter((p) => (p.unit_code ?? u) === u);
  const other = pts.filter((p) => (p.unit_code ?? u) !== u);
  const band = data.reference_band && (data.reference_band.unit_code ?? u) === u ? { ...(data.reference_band.low ? { low: data.reference_band.low } : {}), ...(data.reference_band.high ? { high: data.reference_band.high } : {}) } : undefined;
  return (
    <Dialog title={`Trend — ${analyte}`} isOpen onClose={onClose} size="lg">
      {plotted.length < MIN_POINTS ? (
        <p>Not enough history to draw a trend (needs 2 results).</p>
      ) : (
        <>
          {/* T0D-UIGUARD-1-LAB (LD-353 rule 6): the chart sits in the kit ChartCard */}
          <ChartCard title={`${analyte} trend`}>
            <TimeSeriesChart title={`${analyte} trend`} series={[{ id: 'v', label: analyte, points: plotted.map((p) => ({ at: p.at, value: p.value })) }]} {...(band ? { referenceBand: band } : {})} {...(u ? { unit: u } : {})} />
          </ChartCard>
          <Button variant="ghost" onPress={() => setAsTable((v) => !v)}>{asTable ? 'Hide table' : 'Show as table'}</Button>
          {asTable ? (
            <DataTable caption={`${analyte} values`} rows={plotted} getRowId={(p) => p.result_id} emptyState={{ title: 'No values.' }} columns={POINT_COLS} />
          ) : null}
        </>
      )}
      {other.length ? (
        <section>
          <p role="heading" aria-level={3} className="lims-card-title">Not plotted (different unit)</p>
          <DataTable caption={`${analyte} values not plotted`} rows={other} getRowId={(p) => p.result_id} emptyState={{ title: 'No values.' }} columns={POINT_COLS} />
        </section>
      ) : null}
    </Dialog>
  );
}
