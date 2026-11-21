'use client';
// S17 report content (04-UI-UX §3 S17; AC-21.1-.7, AC-21.9). The column list comes from the API (ColumnMeta { key, label, is_cost }); the screen shows what it is given,
// formats it, and never computes totals or CPT itself (CV §4.7). Cost columns are dropped here too when the caller lacks inventory.cost.read (REQ-SEC-081, defence in depth).
// LD-140 (2026-11-13): kit components only (DataTable, BarChart, Drawer, MoneyText); status = tone + icon + word, e.g. "Expired", "Incomplete".
import { useState, type ReactNode } from 'react';
import { BarChart } from '@lims/ui/components/BarChart';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { Stack } from '@lims/ui/components/Stack';
import type { ReportCode, ReportResult, ReportRow } from '../server/types';
import { Chip } from './shared';

const EMPTY = { title: 'No data for this period' };
export const CPT_FOOTNOTE = 'CPT excludes wastage, expiry and count differences. See the Wastage report.';

/** Movement kinds in words (never the raw enum). */
const MOVEMENT: Record<string, string> = {
  consume_test: 'Per test',
  consume_analyte: 'Per analyte result',
  consume_rerun: 'Per rerun',
  consume_qc: 'Per QC observation',
  consume_calibration: 'Per calibration',
  consume_fixed: 'Per analyser-day',
};
const CATEGORY: Record<string, string> = { wastage: 'Wastage', expiry_writeoff: 'Expiry write-off', count_variance: 'Count variance' };
const words = (s: string) => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const paisa = (n: number) => <MoneyText value={{ amountPaisa: n, currency: 'NPR' }} />;

type Row = ReportRow & { __total?: true };

function cellOf(key: string, v: unknown): ReactNode {
  if (v === undefined || v === null || v === '') return '—';
  if (key.endsWith('_paisa') && typeof v === 'number') return paisa(v);
  if (key === 'movement_kind' && typeof v === 'string') return MOVEMENT[v] ?? words(v);
  if (key === 'category' && typeof v === 'string') return CATEGORY[v] ?? words(v);
  if (key === 'days_to_expiry' && typeof v === 'number') {
    return v < 0 ? (
      <>
        <Chip tone="danger" label="Expired" /> {`${-v} day${v === -1 ? '' : 's'} ago`}
      </>
    ) : v === 0 ? (
      'Expires today'
    ) : (
      `Expires in ${v} day${v === 1 ? '' : 's'}`
    );
  }
  return String(v);
}

const NUMERIC = /(^|_)(qty|tests?|diff|count|counted|days|events|records|value|paisa|cpt)($|_)/;

/** Columns the caller may see: API list minus cost columns without inventory.cost.read. */
function visible(r: ReportResult, canCost: boolean) {
  return r.columns.filter((c) => canCost || (!c.is_cost && !/_paisa/.test(c.key)));
}

function apiColumns(r: ReportResult, canCost: boolean, extra: ColumnDef<Row>[] = [], skip: ReadonlySet<string> = new Set()): ColumnDef<Row>[] {
  const cols = visible(r, canCost).filter((c) => !skip.has(c.key));
  return [
    ...cols.map<ColumnDef<Row>>((c, i) => ({
      id: c.key,
      header: c.label,
      ...(i === 0 ? { isRowHeader: true } : {}),
      ...(NUMERIC.test(c.key) ? { align: 'end' as const } : {}),
      cell: (row) => (row.__total ? (i === 0 ? 'Total' : row[c.key] === undefined ? '' : cellOf(c.key, row[c.key])) : cellOf(c.key, row[c.key])),
    })),
    ...extra,
  ];
}

/** Rows plus the API totals row (shown as given, no client re-sum). */
function withTotals(r: ReportResult): Row[] {
  const total = Object.keys(r.totals ?? {}).length ? [{ ...r.totals, __total: true as const }] : [];
  return [...r.rows, ...total];
}
const rowId = (row: Row, i: number) => (row.__total ? 'total' : `r${i}`);

function Table({ caption, columns, rows }: { caption: string; columns: ColumnDef<Row>[]; rows: Row[] }) {
  return <DataTable caption={caption} columns={columns} rows={rows} getRowId={(row) => rowId(row, rows.indexOf(row))} emptyState={EMPTY} />;
}

export function ReportBody({ code, result, canCost }: { code: ReportCode; result: ReportResult; canCost: boolean }) {
  const [crumb, setCrumb] = useState<Row>();
  const truncated = result.truncated ? (
    <Banner tone="info" title="Showing the first 5,000 rows only">
      <p>Narrow the period or filters, or use Export CSV for the full report.</p>
    </Banner>
  ) : null;

  if (code === 'consumption_reconciliation') {
    // AC-21.7: two tables. The analyser block is a list only (no alert; D-74).
    const isAnalyser = (r: ReportRow) => r['instrument_qc_records'] !== undefined;
    const tests = result.rows.filter((r) => !isAnalyser(r));
    const analysers = result.rows.filter(isAnalyser);
    const qcOf = (r: Row) => r['c12_qc_observations'] ?? r['qc_events'];
    const aCols: ColumnDef<Row>[] = [
      { id: 'date', header: 'Date', isRowHeader: true, cell: (r) => cellOf('business_date', r['business_date']) },
      { id: 'analyser', header: 'Analyser', cell: (r) => cellOf('instrument_label', r['instrument_label']) },
      { id: 'qc', header: 'QC observations', align: 'end', cell: (r) => cellOf('qty', qcOf(r)) },
      { id: 'rec', header: 'Analyser QC records', align: 'end', cell: (r) => cellOf('qty', r['instrument_qc_records']) },
      { id: 'diff', header: 'Difference', align: 'end', cell: (r) => cellOf('diff', r['diff']) },
    ];
    const skip = new Set(['instrument_label', 'c12_qc_observations', 'qc_events', 'instrument_qc_records']);
    return (
      <Stack>
        {truncated}
        {/* T0D-UIGUARD-1-INVENTORY (LD-436 R7): the two blocks are kit Cards with a title row, not raw h2. */}
        <Card title="Tests: C12 verified results against the lab">
          <Table caption="Tests" columns={apiColumns(result, canCost, [], skip)} rows={tests} />
        </Card>
        <Card title="Analysers: QC observations against analyser QC records">
          <Table caption="Analysers" columns={aCols} rows={analysers} />
        </Card>
      </Stack>
    );
  }

  if (code === 'cost_per_test') {
    const extra: ColumnDef<Row>[] = [{ id: 'breakdown', header: 'Breakdown', cell: (r) => (r.__total ? null : <Button size="sm" onPress={() => setCrumb(r)}>Breakdown</Button>) }];
    const cols = apiColumns(result, canCost, extra).map((c) =>
      c.id === 'cpt_standard_paisa' ? { ...c, cell: (r: Row) => <>{c.cell(r)}{!r.__total && r['standard_is_complete'] === false ? <> <Chip tone="warning" label="Incomplete" /></> : null}</> } : c,
    );
    const lines = (crumb?.['breakdown'] ?? []) as { movement_kind: string; value_paisa: number }[];
    const bCols: ColumnDef<{ movement_kind: string; value_paisa: number }>[] = [
      { id: 'kind', header: 'Kind', isRowHeader: true, cell: (l) => cellOf('movement_kind', l.movement_kind) },
      { id: 'value', header: 'Value', align: 'end', cell: (l) => paisa(l.value_paisa) },
    ];
    return (
      <Stack>
        {truncated}
        <Table caption="Cost per test" columns={cols} rows={withTotals(result)} />
        <p>{CPT_FOOTNOTE}</p>
        <Drawer title={`Cost breakdown: ${String(crumb?.['test_code'] ?? '')}`} isOpen={!!crumb} onClose={() => setCrumb(undefined)}>
          <DataTable caption="Breakdown by kind" columns={bCols} rows={lines} getRowId={(l) => l.movement_kind} density="compact" emptyState={{ title: 'No breakdown for this row' }} />
        </Drawer>
      </Stack>
    );
  }

  if (code === 'analyser_consumption') {
    // AC-21.2: grouped by analyser; the per-test counts (tests, reruns, QC events) sit in the row as a sub-list.
    const tests = (r: Row) => (r['tests'] ?? []) as { test_code: string; tests_counted: number; rerun_events: number; qc_events: number }[];
    const extra: ColumnDef<Row>[] = [
      {
        id: 'tests',
        header: 'Tests',
        cell: (r) =>
          r.__total ? null : (
            <Stack>
              {tests(r).map((t) => (
                <span key={t.test_code}>{`${t.test_code}: ${t.tests_counted} tests, ${t.rerun_events} reruns, ${t.qc_events} QC events`}</span>
              ))}
            </Stack>
          ),
      },
    ];
    return (
      <Stack>
        {truncated}
        <Table caption="Analyser-wise consumption" columns={apiColumns(result, canCost, extra)} rows={withTotals(result)} />
      </Stack>
    );
  }

  const rows = withTotals(result);
  // AC-21.1: quantity per day. Quantity only: the chart never carries money, so it needs no cost gating.
  const days = [...new Set(result.rows.map((r) => String(r['business_date'] ?? '')).filter(Boolean))].sort();
  const perDay = days.map((d) => result.rows.filter((r) => r['business_date'] === d).reduce((s, r) => s + Number(r['qty_consumed'] ?? 0), 0));
  return (
    <Stack>
      {truncated}
      {/* T0D-UIGUARD-1-INVENTORY (LD-353 rule 6, LD-436 Today mock): the chart sits in a ChartCard. */}
      {code === 'daily_consumption' && days.length ? (
        <ChartCard title="Daily consumption: quantity per day">
          <BarChart title="Daily consumption: quantity per day" categories={days} series={[{ id: 'qty', label: 'Quantity', values: perDay }]} />
        </ChartCard>
      ) : null}
      <Table caption={code === 'daily_consumption' ? 'Daily consumption' : code === 'wastage' ? 'Wastage by category' : code === 'expiry' ? 'Expiry' : 'Stock valuation'} columns={apiColumns(result, canCost)} rows={rows} />
    </Stack>
  );
}
