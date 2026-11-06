import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';

export interface EditableGridColumn {
  id: string;
  header: string;
  maxLength?: number;
  isReadOnly?: boolean;
}

export type EditableGridRowStatus = 'saved' | 'unsaved' | 'error';

export interface EditableGridRow {
  id: string;
  values: Record<string, string>;
  status?: EditableGridRowStatus;
  /** Overrides the default status text. */
  statusText?: string;
  errors?: Record<string, string>;
}

export interface EditableGridProps {
  label: string;
  columns: readonly EditableGridColumn[];
  rows: readonly EditableGridRow[];
  onCellChange: (rowId: string, colId: string, value: string) => void;
  isReadOnly?: boolean;
  'data-testid'?: string;
}

const STATUS: Record<EditableGridRowStatus, string> = { saved: 'Saved', unsaved: 'Unsaved changes', error: 'Error' };
const statusOf = (r: EditableGridRow) => (r.status ? (r.statusText ?? STATUS[r.status]) : '');

/**
 * APG data grid (C3 coded values): one tab stop (roving tabindex), arrows/Home/End move, Enter/F2 edits,
 * Enter commits, Esc cancels. Last column is the row status as text, announced politely (C3 04-UI-UX:217).
 */
export function EditableGrid({ label, columns, rows, onCellChange, isReadOnly = false, ...rest }: EditableGridProps) {
  const id = useId();
  const [active, setActive] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ r: number; c: number; draft: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const cells = useRef(new Map<string, HTMLElement>());
  const wantFocus = useRef(false);
  const closing = useRef(false);
  const prevStatus = useRef(new Map<string, string>());
  const nCols = columns.length + 1; // + status
  const r = Math.min(active.r, Math.max(rows.length - 1, 0));
  const c = Math.min(active.c, nCols - 1);

  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    cells.current.get(`${r}:${c}`)?.focus();
  });

  useEffect(() => {
    const changed: string[] = [];
    rows.forEach((row, i) => {
      const s = statusOf(row);
      const before = prevStatus.current.get(row.id);
      if (before !== undefined && before !== s && s) changed.push(`Row ${i + 1}: ${s}`);
      prevStatus.current.set(row.id, s);
    });
    if (changed.length) setAnnounce(changed.join('. '));
  }, [rows]);

  const move = (nr: number, nc: number) => {
    wantFocus.current = true;
    setActive({ r: Math.max(0, Math.min(rows.length - 1, nr)), c: Math.max(0, Math.min(nCols - 1, nc)) });
  };
  const editable = (ci: number) => !isReadOnly && ci < columns.length && !columns[ci]!.isReadOnly;
  const startEdit = (ri: number, ci: number) => {
    closing.current = false;
    setEditing({ r: ri, c: ci, draft: rows[ri]!.values[columns[ci]!.id] ?? '' });
  };
  const finish = (commit: boolean) => {
    if (!editing) return;
    closing.current = true;
    const row = rows[editing.r];
    const col = columns[editing.c];
    if (commit && row && col && editing.draft !== (row.values[col.id] ?? '')) onCellChange(row.id, col.id, editing.draft);
    setEditing(null);
    wantFocus.current = true;
  };

  const onCellKey = (e: KeyboardEvent, ri: number, ci: number) => {
    if (editing) return;
    const k = e.key;
    if (k === 'ArrowRight') move(ri, ci + 1);
    else if (k === 'ArrowLeft') move(ri, ci - 1);
    else if (k === 'ArrowDown') move(ri + 1, ci);
    else if (k === 'ArrowUp') move(ri - 1, ci);
    else if (k === 'Home') move(e.ctrlKey ? 0 : ri, 0);
    else if (k === 'End') move(e.ctrlKey ? rows.length - 1 : ri, nCols - 1);
    else if ((k === 'Enter' || k === 'F2') && editable(ci)) startEdit(ri, ci);
    else return;
    e.preventDefault();
  };

  return (
    <div className="lims-egrid" {...rest}>
      <table
        role="grid"
        aria-label={label}
        aria-rowcount={rows.length + 1}
        aria-colcount={nCols}
        {...(isReadOnly ? { 'aria-readonly': true } : {})}
        className="lims-table lims-egrid-table"
      >
        <thead>
          <tr role="row" aria-rowindex={1}>
            {columns.map((col, ci) => (
              <th key={col.id} role="columnheader" aria-colindex={ci + 1} scope="col">
                {col.header}
              </th>
            ))}
            <th role="columnheader" aria-colindex={nCols} scope="col">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.id} role="row" aria-rowindex={ri + 2} data-status={row.status}>
              {[...columns, null].map((col, ci) => {
                const isActive = ri === r && ci === c;
                const err = col ? row.errors?.[col.id] : undefined;
                const isEditing = editing && editing.r === ri && editing.c === ci && col;
                const errId = `${id}-e-${ri}-${ci}`;
                return (
                  <td
                    key={col?.id ?? '__status'}
                    role="gridcell"
                    aria-colindex={ci + 1}
                    tabIndex={isActive && !isEditing ? 0 : -1}
                    ref={(el) => {
                      if (el) cells.current.set(`${ri}:${ci}`, el);
                      else cells.current.delete(`${ri}:${ci}`);
                    }}
                    {...(col && !editable(ci) ? { 'aria-readonly': true } : {})}
                    {...(err ? { 'aria-invalid': true, 'aria-describedby': errId } : {})}
                    onFocus={() => (ri !== active.r || ci !== active.c) && setActive({ r: ri, c: ci })}
                    onKeyDown={(e) => onCellKey(e, ri, ci)}
                    onDoubleClick={() => editable(ci) && startEdit(ri, ci)}
                    className={col ? undefined : 'lims-egrid-status'}
                  >
                    {isEditing ? (
                      <input
                        className="lims-input"
                        autoFocus
                        aria-label={`${col.header}, row ${ri + 1}`}
                        {...(col.maxLength !== undefined ? { maxLength: col.maxLength } : {})}
                        value={editing.draft}
                        onChange={(e) => setEditing({ ...editing, draft: e.target.value.normalize('NFC') })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') finish(true);
                          else if (e.key === 'Escape') finish(false);
                          else return;
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onBlur={() => !closing.current && finish(true)}
                      />
                    ) : col ? (
                      row.values[col.id] ?? ''
                    ) : (
                      statusOf(row)
                    )}
                    {err ? (
                      <span id={errId} className="lims-error">
                        {' '}
                        {err}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <VisuallyHidden>
        <span aria-live="polite">{announce}</span>
      </VisuallyHidden>
    </div>
  );
}
