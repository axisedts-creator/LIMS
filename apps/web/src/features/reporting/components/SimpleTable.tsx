'use client';
// Compact data table on a native <table> with a <caption> (04-UI-UX §1: compact density, caption set, cursor paging).
// [CONV] The kit DataTable renders an ARIA grid without a <caption>; the reporting screens are read-mostly lists that need role=table + caption,
// so they use native table semantics with the kit's lims-table classes. Selection = native checkboxes with a per-row accessible name.
import type { ReactNode } from 'react';
import { EmptyState } from '@lims/ui/components/EmptyState';

export interface Col<R> { id: string; header: string; cell: (r: R) => ReactNode; rowHeader?: boolean }
export interface Selection { selectedIds: ReadonlySet<string>; onChange: (ids: ReadonlySet<string>) => void; max?: number; label: (id: string) => string }

export function SimpleTable<R>({ columns, rows, getRowId, caption, empty, selection }: {
  columns: readonly Col<R>[]; rows: readonly R[]; getRowId: (r: R) => string; caption: string; empty: { title: string; body?: string }; selection?: Selection;
}) {
  if (rows.length === 0) return <EmptyState {...empty} />;
  const ids = rows.map(getRowId);
  const all = selection ? ids.every((i) => selection.selectedIds.has(i)) : false;
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
                <input type="checkbox" aria-label="Select all rows" checked={all} onChange={(e) => selection.onChange(e.currentTarget.checked ? new Set(ids.slice(0, selection.max ?? 200)) : new Set())} />
              </th>
            ) : null}
            {columns.map((c) => <th key={c.id} scope="col" className="lims-col">{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const id = getRowId(r);
            return (
              <tr key={id} className="lims-row">
                {selection ? (
                  <td className="lims-cell-select">
                    <input type="checkbox" aria-label={selection.label(id)} checked={selection.selectedIds.has(id)} onChange={(e) => toggle(id, e.currentTarget.checked)} />
                  </td>
                ) : null}
                {columns.map((c) => (c.rowHeader ? <th key={c.id} scope="row" className="lims-cell">{c.cell(r)}</th> : <td key={c.id} className="lims-cell">{c.cell(r)}</td>))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
