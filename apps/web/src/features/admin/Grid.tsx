// Read-only data grid for admin lists (server or client). Status and badges are text, never colour only (04-UI-UX §8).
import type { ReactNode } from 'react';

export interface Row { key: string; cells: ReactNode[]; onClick?: () => void }

export function Grid({ label, columns, rows }: { label: string; columns: readonly string[]; rows: readonly Row[] }) {
  return (
    <table role="grid" aria-label={label} className="lims-table">
      <thead>
        <tr role="row">{columns.map((c) => <th key={c} role="columnheader" scope="col">{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} role="row" {...(r.onClick ? { onClick: r.onClick, className: 'lims-row-click' } : {})}>
            {r.cells.map((c, i) => <td key={i} role="gridcell">{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const Badge = ({ text }: { text: string }) => <span className="lims-chip lims-chip-sm">{text}</span>;
export const Time = ({ iso, label }: { iso: string | undefined | null; label: string }) => (iso ? <time dateTime={iso} title={`${iso} (UTC)`}>{label}</time> : <>—</>);
