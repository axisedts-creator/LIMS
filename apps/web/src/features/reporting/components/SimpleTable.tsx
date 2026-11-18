'use client';
// Compact data table on a native <table> with a <caption> (04-UI-UX §1: compact density, caption set, cursor paging).
// [CONV] The kit DataTable renders an ARIA grid without a <caption>; the reporting screens are read-mostly lists that need role=table + caption,
// so they use native table semantics with the kit's lims-table classes. Selection = native checkboxes with a per-row accessible name.
import type { ReactNode } from 'react';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';

// ponytail: plain-text heuristics (a digits-only code column also aligns right); a per-column `align` prop if that ever reads wrong.
const NUMBER = /^-?[\d,]+(\.\d+)?$/;
const isNumberColumn = (vs: readonly ReactNode[]) => vs.length > 0 && vs.every((v) => (typeof v === 'string' || typeof v === 'number') && NUMBER.test(String(v).trim()));
const cutOff = (v: ReactNode) => typeof v === 'string' && v.length > 32;

export interface Col<R> { id: string; header: string; cell: (r: R) => ReactNode; rowHeader?: boolean }
export interface Selection { selectedIds: ReadonlySet<string>; onChange: (ids: ReadonlySet<string>) => void; max?: number; label: (id: string) => string }

export function SimpleTable<R>({ columns, rows, getRowId, caption, empty, selection }: {
  columns: readonly Col<R>[]; rows: readonly R[]; getRowId: (r: R) => string; caption: string; empty: { title: string; body?: string }; selection?: Selection;
}) {
  // T0D-EMPTYTBL-1 (LD-310): no early return; an empty list keeps its header row, the message sits in the body.
  const ids = rows.map(getRowId);
  // T0D-UNSLOP-1 (LD-353 rules 3 and 5): an all-number column is right aligned (header too); a long text cell carries its full value as title.
  const vals = rows.map((r) => columns.map((c) => c.cell(r)));
  const end = columns.map((_, i) => (isNumberColumn(vals.map((v) => v[i])) ? ' lims-align-end' : ''));
  const span = columns.length + (selection ? 1 : 0);
  const all = selection && ids.length > 0 ? ids.every((i) => selection.selectedIds.has(i)) : false;
  const toggle = (id: string, on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selectedIds);
    if (on) { if (next.size >= (selection.max ?? 200)) return; next.add(id); } else next.delete(id);
    selection.onChange(next);
  };
  return (
    <div className="lims-table-scroll">
      <table className="lims-table lims-table-compact">
        <caption className="lims-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {selection ? (
              <th scope="col" className="lims-col-select">
                <input type="checkbox" aria-label="Select all rows" checked={all} disabled={ids.length === 0}onChange={(e) => selection.onChange(e.currentTarget.checked ? new Set(ids.slice(0, selection.max ?? 200)) : new Set())} />
              </th>
            ) : null}
            {columns.map((c, i) => <th key={c.id} scope="col" className={`lims-col${end[i]}`}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow colSpan={span}><EmptyState {...empty} /></EmptyRow> : null}
          {rows.map((r, ri) => {
            const id = getRowId(r);
            return (
              <tr key={id} className="lims-row">
                {selection ? (
                  <td className="lims-cell-select">
                    <input type="checkbox" aria-label={selection.label(id)} checked={selection.selectedIds.has(id)} onChange={(e) => toggle(id, e.currentTarget.checked)} />
                  </td>
                ) : null}
                {columns.map((c, i) => {
                  const v = vals[ri]![i];
                  const p = { className: `lims-cell${end[i]}`, ...(cutOff(v) ? { title: v as string } : {}) };
                  return c.rowHeader ? <th key={c.id} scope="row" {...p}>{v}</th> : <td key={c.id} {...p}>{v}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
        {rows.length === 0 ? <PlaceholderRows colSpan={span} /> : null}
      </table>
    </div>
  );
}
