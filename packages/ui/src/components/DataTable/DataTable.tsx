'use client';
// 04-UI-UX §2.5 DataTable on react-aria Table (role=grid): sort, selection, keyboard, row actions, cursor paging, virtualisation.
// Rows are rendered through column.cell() only; the kit never serialises rows (REQ-SEC-081).
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  Button as RacButton,
  Cell,
  Checkbox as RacCheckbox,
  Column,
  Menu as RacMenu,
  MenuItem,
  Popover,
  Row as RacRow,
  Table,
  TableBody,
  TableHeader,
  type Selection,
  type SortDescriptor,
} from 'react-aria-components';
import { Button } from '../Button/Button';
import { EmptyState, type EmptyStateProps } from '../EmptyState/EmptyState';
import { StatusChip, statusOf, type StatusChipProps } from '../StatusChip/StatusChip';
import { ErrorState } from '../ErrorState/ErrorState';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';

export interface ColumnDef<Row> {
  id: string;
  header: string;
  cell: (r: Row) => ReactNode;
  align?: 'start' | 'end' | 'center';
  width?: number | 'auto';
  /** Must be one of the operation's sort enum values. */
  sortKey?: string;
  isRowHeader?: boolean;
  hideBelow?: 'md' | 'lg' | 'xl';
  /** T0D-UIKIT-1, LD-353 rules 3 and 5: right aligned (header too) with tabular digits. */
  numeric?: boolean;
}

export interface DataTableProps<Row> {
  columns: readonly ColumnDef<Row>[];
  rows: readonly Row[];
  getRowId: (r: Row) => string;
  isLoading?: boolean;
  error?: { title: string; requestId?: string; onRetry?: () => void };
  emptyState: EmptyStateProps;
  /** Cursor pagination only (CV §4.3): no page numbers, no totals. */
  /** T0D-UIDASH-2 (LD-436 worklist pager): the row total of the list; draws "Showing 1 to n of total" in the pager. */
  total?: number;
  page?: { hasNext: boolean; hasPrevious: boolean; onNext: () => void; onPrevious: () => void; limit: number };
  /** value like 'received_at' or '-received_at' (descending). */
  sort?: { value: string; onChange: (v: string) => void };
  selection?: { mode: 'single' | 'multiple'; selectedIds: ReadonlySet<string>; onChange: (ids: ReadonlySet<string>) => void; max?: number | undefined };
  /** Rows 32 / 40 / 48 px (10-DESIGN-SYSTEM §2.4). */
  density?: 'compact' | 'regular' | 'comfortable';
  stickyHeader?: boolean;
  /** Adds a "Status" column with a StatusChip (tone + icon + word) and data-tone on the row (LD-140). */
  rowStatus?: (r: Row) => StatusChipProps | undefined;
  /** Shown in a "Bulk actions" toolbar while rows are selected. */
  bulkActions?: readonly { id: string; label: string; isDanger?: boolean }[];
  onBulkAction?: (actionId: string, selectedIds: ReadonlySet<string>) => void;
  /** Enter / double-click. */
  onRowAction?: (r: Row) => void;
  rowActions?: (r: Row) => readonly { id: string; label: string; isDanger?: boolean }[];
  onRowActionMenu?: (r: Row, actionId: string) => void;
  /** Accessible table name. */
  caption: string;
  /** Default true when rows > 200. */
  virtualize?: boolean;
  /** T0D-UIKIT-1, LD-353 rule 5: the first data column stays in view while the table scrolls sideways. */
  stickyFirstColumn?: boolean;
  /** T0D-UIKIT-1, LD-353 rule 5 (tables over 8 columns): a "Columns" button that shows or hides columns. */
  columnChooser?: boolean;
  /** T0D-UIKIT-1, LD-353 rule 5: text cells carry title = their text, so a cut off cell can be read. */
  cellTitle?: boolean;
  'data-testid'?: string;
}

/** T0D-EMPTYTBL-1 (LD-310): four faint rows under the empty message keep the table's height; inert (aria-hidden, no focus, no pointer events in kit.css). */
const PLACEHOLDERS = [0, 1, 2, 3] as const;

/** Empty native <table>, part 1: the message in one full-width body row. Use inside <tbody>. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr className="lims-row-empty">
      <td className="lims-cell" colSpan={colSpan}>{children}</td>
    </tr>
  );
}

/** Empty native <table>, part 2: the four placeholder rows, in an aria-hidden <tfoot> after </tbody> so the body holds only the message row. */
export function PlaceholderRows({ colSpan }: { colSpan: number }) {
  return (
    <tfoot aria-hidden="true">
      {PLACEHOLDERS.map((i) => (
        <tr key={i} className="lims-row-placeholder" aria-hidden="true">
          <td colSpan={colSpan} />
        </tr>
      ))}
    </tfoot>
  );
}

const BULK_MAX = 200; // CV §4.1
const ROW_HEIGHT = 40;
const WINDOW = 60;

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  isLoading,
  error,
  emptyState,
  page,
  total,
  sort,
  selection,
  density = 'regular',
  stickyHeader = true,
  rowStatus,
  bulkActions,
  onBulkAction,
  onRowAction,
  rowActions,
  onRowActionMenu,
  caption,
  virtualize,
  stickyFirstColumn,
  columnChooser,
  cellTitle,
  ...rest
}: DataTableProps<Row>) {
  const [menu, setMenu] = useState<{ row: Row } | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [chooserOpen, setChooserOpen] = useState(false);
  const [start, setStart] = useState(0);
  const anchor = useRef<HTMLElement | null>(null);
  const grid = useRef<HTMLTableElement>(null);
  const isVirtual = virtualize ?? rows.length > 200;
  // react-aria's Table drops these attributes; set them on the grid element directly.
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    if (isLoading) el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
    if (isVirtual) {
      el.setAttribute('aria-rowcount', String(rows.length + 1));
      el.querySelectorAll<HTMLElement>('tbody [data-row-index]').forEach((r) => r.setAttribute('aria-rowindex', String(Number(r.dataset['rowIndex']) + 2)));
    } else el.removeAttribute('aria-rowcount');
  });
  const byId = new Map(rows.map((r) => [getRowId(r), r]));
  const rowOf = (el: EventTarget | null) => {
    const id = (el as HTMLElement | null)?.closest?.('[data-row-id]')?.getAttribute('data-row-id');
    return id != null ? byId.get(id) : undefined;
  };

  const sortCol = sort ? columns.find((c) => c.sortKey && c.sortKey === sort.value.replace(/^-/, '')) : undefined;
  const sortDescriptor: SortDescriptor | undefined = sortCol ? { column: sortCol.id, direction: sort!.value.startsWith('-') ? 'descending' : 'ascending' } : undefined;

  const onSelectionChange = (keys: Selection) => {
    if (!selection) return;
    const ids = new Set(keys === 'all' ? rows.map(getRowId) : [...keys].map(String));
    if (ids.size > (selection.max ?? BULK_MAX)) return;
    selection.onChange(ids);
  };

  const openMenu = (row: Row, el: HTMLElement) => {
    anchor.current = el;
    setMenu({ row });
  };

  const onKeyDownCapture = (e: KeyboardEvent) => {
    const role = (e.target as HTMLElement).getAttribute?.('role');
    if (role !== 'gridcell' && role !== 'rowheader' && role !== 'row') return;
    const row = rowOf(e.target);
    if (!row) return;
    if (e.key === 'Enter' && onRowAction) {
      e.preventDefault();
      e.stopPropagation();
      onRowAction(row);
    } else if (rowActions && ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) {
      e.preventDefault();
      e.stopPropagation();
      openMenu(row, e.target as HTMLElement);
    }
  };
  const onDoubleClick = (e: MouseEvent) => {
    const row = onRowAction && rowOf(e.target);
    if (row) onRowAction!(row);
  };

  const virtual = isVirtual;
  const first = virtual ? Math.min(start, Math.max(0, rows.length - WINDOW)) : 0;
  // LD-353 rule 5: on error the header row stays and the ErrorState sits in the body (T0D-UIKIT-1)
  const shown = error ? [] : virtual ? rows.slice(first, first + WINDOW) : rows;
  const cols = columnChooser ? columns.filter((c) => !hidden.has(c.id)) : columns;
  const stickyId = stickyFirstColumn ? cols[0]?.id : undefined;
  const align = (c: ColumnDef<Row>) =>
    `lims-align-${c.align ?? (c.numeric ? 'end' : 'start')}${c.numeric ? ' lims-num' : ''}${c.id === stickyId ? ' lims-sticky-first' : ''}${c.hideBelow ? ` lims-hide-below-${c.hideBelow}` : ''}`;
  const toggle = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else if (columns.length - n.size > 1) n.add(id); // never hide the last column
      return n;
    });

  const table = (
    <Table
      ref={grid}
      aria-label={caption}
      className={`lims-table lims-table-${density}${stickyHeader ? ' lims-table-sticky' : ''}`}
      selectionMode={selection?.mode ?? 'none'}
      {...(selection ? { selectedKeys: new Set(selection.selectedIds), onSelectionChange } : {})}
      {...(sort ? { onSortChange: (d: SortDescriptor) => { const c = columns.find((x) => x.id === d.column); if (c?.sortKey) sort.onChange(d.direction === 'descending' ? `-${c.sortKey}` : c.sortKey); } } : {})}
      {...(sortDescriptor ? { sortDescriptor } : {})}
    >
      <TableHeader>
        {selection ? (
          <Column className="lims-col-select" width={40}>
            {selection.mode === 'multiple' ? <RacCheckbox slot="selection" className="lims-checkbox" /> : <VisuallyHidden>Select</VisuallyHidden>}
          </Column>
        ) : null}
        {cols.map((c) => (
          <Column key={c.id} id={c.id} isRowHeader={!!c.isRowHeader} allowsSorting={!!(sort && c.sortKey)} className={`lims-col ${align(c)}`} {...(typeof c.width === 'number' ? { width: c.width } : {})}>
            {c.header}
          </Column>
        ))}
        {rowStatus ? <Column className="lims-col lims-col-status">Status</Column> : null}
        {rowActions ? (
          <Column className="lims-col-actions" width={56}>
            <VisuallyHidden>Actions</VisuallyHidden>
          </Column>
        ) : null}
      </TableHeader>
      {/* react-aria renders the empty state in one cell, so the T0D-EMPTYTBL-1 placeholder rows are inert divs inside it (LD-310). */}
      <TableBody renderEmptyState={() => (error ? (
        <ErrorState title={error.title} {...(error.requestId ? { requestId: error.requestId } : {})} {...(error.onRetry ? { onRetry: error.onRetry } : {})} />
      ) : isLoading ? null : (
        <>
          <EmptyState {...emptyState} />
          {PLACEHOLDERS.map((i) => <div key={i} className="lims-row-placeholder" aria-hidden="true" />)}
        </>
      ))}>
        {shown.map((r, i) => {
          const id = getRowId(r);
          const st = rowStatus?.(r);
          return (
            <RacRow key={id} id={id} data-row-id={id} data-row-index={first + i} className="lims-row" {...(st ? { 'data-tone': statusOf(st.kind, String(st.status ?? ''), st.tone, st.label)[0] } : {})}>
              {selection ? (
                <Cell className="lims-cell-select">
                  <RacCheckbox slot="selection" className="lims-checkbox" />
                </Cell>
              ) : null}
              {cols.map((c) => {
                const v = c.cell(r);
                // T0D-UIKIT-1 cellTitle: react-aria's Cell drops `title`, so a text cell gets it through its ref (an attribute value, never markup)
                const text = cellTitle && (typeof v === 'string' || typeof v === 'number') ? String(v) : undefined;
                return (
                  <Cell key={c.id} className={`lims-cell ${align(c)}`} {...(text ? { ref: (el: HTMLTableCellElement | null) => { if (el) el.title = text; } } : {})}>
                    {v}
                  </Cell>
                );
              })}
              {rowStatus ? <Cell className="lims-cell lims-cell-status">{st ? <StatusChip {...st} /> : null}</Cell> : null}
              {rowActions ? (
                <Cell className="lims-cell-actions">
                  <RacButton aria-label="Row actions" className="lims-btn lims-btn-ghost lims-icon-btn" onPress={(e) => openMenu(r, e.target as HTMLElement)}>
                    <span aria-hidden="true">⋯</span>
                  </RacButton>
                </Cell>
              ) : null}
            </RacRow>
          );
        })}
      </TableBody>
    </Table>
  );

  return (
    <div className={`lims-data-table${cellTitle ? ' lims-cell-titles' : ''}`} onKeyDownCapture={onKeyDownCapture} onDoubleClick={onDoubleClick} {...rest}>
      {selection && bulkActions?.length && selection.selectedIds.size > 0 ? (
        <div role="toolbar" aria-label="Bulk actions" className="lims-bulk-bar">
          <span className="lims-bulk-count">{selection.selectedIds.size} selected</span>
          {bulkActions.map((a) => (
            <Button key={a.id} size="sm" variant={a.isDanger ? 'danger' : 'secondary'} onPress={() => onBulkAction?.(a.id, selection.selectedIds)}>
              {a.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onPress={() => selection.onChange(new Set())}>
            Clear selection
          </Button>
        </div>
      ) : null}
      {columnChooser ? (
        <div className="lims-colchooser">
          <button type="button" className="lims-btn lims-btn-ghost" aria-expanded={chooserOpen} onClick={() => setChooserOpen((o) => !o)}>
            Columns
          </button>
          {chooserOpen ? (
            <div role="group" aria-label="Columns" className="lims-colchooser-list lims-popover">
              {columns.map((c) => (
                <label key={c.id} className="lims-check">
                  <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => toggle(c.id)} />
                  {c.header}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {virtual ? (
        // ponytail: fixed-height row window; react-aria's Virtualizer renders every row when it cannot measure (jsdom, hidden tabs).
        <div className="lims-table-scroll" style={{ maxHeight: ROW_HEIGHT * 20, overflowY: 'auto' }} onScroll={(e) => setStart(Math.max(0, Math.floor(e.currentTarget.scrollTop / ROW_HEIGHT) - 10))}>
          <div style={{ height: first * ROW_HEIGHT }} />
          {table}
          <div style={{ height: Math.max(0, rows.length - first - shown.length) * ROW_HEIGHT }} />
        </div>
      ) : (
        <div className="lims-table-scroll">{table}</div>
      )}
      <div role="status" className="lims-visually-hidden">
        {isLoading ? 'Loading results' : ''}
      </div>
      {page || total !== undefined ? (
        <div className="lims-pager">
          {total !== undefined ? <span className="lims-pager-total">{shown.length > 0 ? `Showing 1 to ${shown.length} of ${total}` : `0 of ${total}`}</span> : null}
          {page ? (
            <>
              <button type="button" className="lims-btn lims-btn-secondary lims-btn-sm" disabled={!page.hasPrevious} onClick={page.onPrevious}>
                Previous
              </button>
              <button type="button" className="lims-btn lims-btn-secondary lims-btn-sm" disabled={!page.hasNext} onClick={page.onNext}>
                Next
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {menu && rowActions ? (
        <Popover className="lims-popover" triggerRef={anchor} isOpen onOpenChange={(o) => !o && setMenu(null)} placement="bottom start">
          <RacMenu
            aria-label="Row actions"
            className="lims-menu"
            autoFocus="first"
            onAction={(k) => {
              const row = menu.row;
              setMenu(null);
              onRowActionMenu?.(row, String(k));
            }}
          >
            {rowActions(menu.row).map((a) => (
              <MenuItem key={a.id} id={a.id} textValue={a.label} className={a.isDanger ? 'lims-menuitem lims-danger' : 'lims-menuitem'}>
                {a.label}
              </MenuItem>
            ))}
          </RacMenu>
        </Popover>
      ) : null}
    </div>
  );
}
