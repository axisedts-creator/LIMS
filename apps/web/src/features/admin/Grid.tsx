// Read-only data grid for admin lists (server or client). Status and badges are text, never colour only (04-UI-UX §8).
// T0D-UIGUARD-1-ADMIN (LD-436 worklist mock, LD-439): drawn with the kit DataTable classes (header row on neutral.50, one row height,
// cells) and, when `empty` is given, an empty list keeps its header row with the kit EmptyState in the body (LD-353 rule 5).
// [CONV] stays a native table: rows open on a single click (AD-6/AD-7) and server pages pass ready cells, which the kit DataTable
// (react-aria, Enter / double click, cell functions) cannot take across the server boundary.
import type { ReactNode } from 'react';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';

export interface Row { key: string; cells: ReactNode[]; onClick?: () => void }

export function Grid({ label, columns, rows, empty }: { label: string; columns: readonly string[]; rows: readonly Row[]; empty?: ReactNode }) {
  return (
    <div className="lims-data-table">
      <div className="lims-table-scroll">
        <table role="grid" aria-label={label} className="lims-table lims-table-compact">
          <thead>
            <tr role="row">{columns.map((c) => <th key={c} role="columnheader" scope="col" className="lims-col">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} role="row" className={r.onClick ? 'lims-row lims-row-click' : 'lims-row'} {...(r.onClick ? { onClick: r.onClick } : {})}>
                {r.cells.map((c, i) => <td key={i} role="gridcell" className="lims-cell">{c}</td>)}
              </tr>
            ))}
            {!rows.length && empty ? <EmptyRow colSpan={columns.length}>{typeof empty === 'string' ? <EmptyState title={empty} /> : empty}</EmptyRow> : null}
          </tbody>
          {!rows.length && empty ? <PlaceholderRows colSpan={columns.length} /> : null}
        </table>
      </div>
    </div>
  );
}

export const Badge = ({ text }: { text: string }) => <span className="lims-chip lims-chip-sm">{text}</span>;
export const Time = ({ iso, label }: { iso: string | undefined | null; label: string }) => (iso ? <time dateTime={iso} title={`${iso} (UTC)`}>{label}</time> : <>—</>);
