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
}

export interface DataTableProps<Row> {
  columns: readonly ColumnDef<Row>[];
  rows: readonly Row[];
  getRowId: (r: Row) => string;
  isLoading?: boolean;
  error?: { title: string; requestId?: string; onRetry?: () => void };
  emptyState: EmptyStateProps;
  /** Cursor pagination only (CV §4.3): no page numbers, no totals. */
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
  'data-testid'?: string;
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
  ...rest
}: DataTableProps<Row>) {
  const [menu, setMenu] = useState<{ row: Row } | null>(null);
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

  if (error) {
    return <ErrorState title={error.title} {...(error.requestId ? { requestId: error.requestId } : {})} {...(error.onRetry ? { onRetry: error.onRetry } : {})} />;
  }

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
  const shown = virtual ? rows.slice(first, first + WINDOW) : rows;
  const align = (c: ColumnDef<Row>) => `lims-align-${c.align ?? 'start'}${c.hideBelow ? ` lims-hide-below-${c.hideBelow}` : ''}`;

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
        {columns.map((c) => (
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
      <TableBody renderEmptyState={() => (isLoading ? null : <EmptyState {...emptyState} />)}>
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
              {columns.map((c) => (
                <Cell key={c.id} className={`lims-cell ${align(c)}`}>
                  {c.cell(r)}
                </Cell>
              ))}
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
    <div className="lims-data-table" onKeyDownCapture={onKeyDownCapture} onDoubleClick={onDoubleClick} {...rest}>
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
      {virtual ? (
        // ponytail: fixed-height row window; react-aria's Virtualizer renders every row when it cannot measure (jsdom, hidden tabs).
        <div className="lims-table-scroll" style={{ maxHeight: ROW_HEIGHT * 20, overflowY: 'auto' }} onScroll={(e) => setStart(Math.max(0, Math.floor(e.currentTarget.scrollTop / ROW_HEIGHT) - 10))}>
          <div style={{ height: first * ROW_HEIGHT }} />
          {table}
          <div style={{ height: Math.max(0, rows.length - first - shown.length) * ROW_HEIGHT }} />
        </div>
      ) : (
        table
      )}
      <div role="status" className="lims-visually-hidden">
        {isLoading ? 'Loading results' : ''}
      </div>
      {page ? (
        <div className="lims-pager">
          <button type="button" className="lims-btn lims-btn-secondary lims-btn-sm" disabled={!page.hasPrevious} onClick={page.onPrevious}>
            Previous
          </button>
          <button type="button" className="lims-btn lims-btn-secondary lims-btn-sm" disabled={!page.hasNext} onClick={page.onNext}>
            Next
          </button>
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
