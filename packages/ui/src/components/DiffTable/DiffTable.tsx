import { useState } from 'react';

export interface DiffRow {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface DiffTableProps {
  rows: readonly DiffRow[];
  /** Default "Before" / "After". */
  beforeLabel?: string;
  afterLabel?: string;
  /** Values longer than this are collapsed behind a toggle. Default 200. */
  maxValueLength?: number;
  'data-testid'?: string;
}

function Value({ text, max }: { text: string; max: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= max) return <>{text}</>;
  return (
    <>
      <span className="lims-diff-value">{open ? text : `${text.slice(0, max)}…`}</span>{' '}
      <button type="button" className="lims-btn lims-btn-ghost lims-btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Show less' : 'Show full value'}
      </button>
    </>
  );
}

/** Before/after table (C2 audit detail, C3 version compare). "Changed" is text, colour is secondary (AC-0D-8.3). */
export function DiffTable({ rows, beforeLabel = 'Before', afterLabel = 'After', maxValueLength = 200, ...rest }: DiffTableProps) {
  return (
    <table className="lims-table lims-diff" {...rest}>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">{beforeLabel}</th>
          <th scope="col">{afterLabel}</th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.changed ? 'lims-diff-changed' : undefined}>
            <th scope="row">{r.label}</th>
            <td>
              <Value text={r.before} max={maxValueLength} />
            </td>
            <td>
              <Value text={r.after} max={maxValueLength} />
            </td>
            <td>{r.changed ? <span className="lims-chip lims-chip-sm lims-tone-warning" data-tone="warning">Changed</span> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
