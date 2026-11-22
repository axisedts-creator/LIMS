'use client';
// T0D-UIX-4 (LD-442): the reporting read-mostly lists draw the kit DataTable (columns config, density regular, header kept when empty,
// numbers end aligned with tabular figures). The wrapper keeps the old call shape so the screens do not change.
import type { ReactNode } from 'react';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';

// ponytail: plain-text heuristics (a digits-only code column also aligns right); a per-column `numeric` prop if that ever reads wrong.
const NUMBER = /^-?[\d,]+(\.\d+)?$/;
const isNumberColumn = (vs: readonly ReactNode[]) => vs.length > 0 && vs.every((v) => (typeof v === 'string' || typeof v === 'number') && NUMBER.test(String(v).trim()));

export interface Col<R> { id: string; header: string; cell: (r: R) => ReactNode; rowHeader?: boolean }

export function SimpleTable<R>({ columns, rows, getRowId, caption, empty }: {
  columns: readonly Col<R>[]; rows: readonly R[]; getRowId: (r: R) => string; caption: string; empty: { title: string; body?: string };
}) {
  const cols: ColumnDef<R>[] = columns.map((c) => ({
    id: c.id, header: c.header, cell: c.cell, isRowHeader: !!c.rowHeader,
    numeric: isNumberColumn(rows.map((r) => c.cell(r))),
  }));
  return <DataTable caption={caption} columns={cols} rows={rows} getRowId={getRowId} emptyState={empty} density="regular" cellTitle />;
}
