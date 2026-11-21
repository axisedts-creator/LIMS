'use client';
// C13.T19 shared client pieces: calendar-aware date text, status chips by word+tone, and the list screen (table on desktop, card list on phones).
// LD-140 (2026-11-13): built only from @lims/ui components; no hex colours, no inline style objects; every status shows tone, icon and word.
import { createContext, useContext, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef, type DataTableProps } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { EmptyState, type EmptyStateProps } from '@lims/ui/components/EmptyState';
import { StatusChip, type StatusChipProps } from '@lims/ui/components/StatusChip';
import { calendarMode } from './format';

export type Tone = NonNullable<StatusChipProps['tone']>;

const Calendar = createContext<'AD' | 'BS' | 'AD_BS' | 'BS_AD'>('AD');
/** The shell provides the tenant calendarDisplay once; every screen reads it through <Dt>. */
export function CalendarProvider({ value, children }: { value: string | undefined; children: ReactNode }) {
  return <Calendar.Provider value={calendarMode(value)}>{children}</Calendar.Provider>;
}
/** DateText with the tenant calendar; '—' for a missing value. */
export function Dt({ value, withTime }: { value: string | null | undefined; withTime?: boolean }) {
  const mode = useContext(Calendar);
  if (!value) return <>—</>;
  return <DateText value={value as never} mode={mode} {...(withTime ? { withTime: true } : {})} />;
}

/** Status word + tone + icon (StatusChip kind='generic'); unknown codes fall back to neutral + the raw code (x-extensible enums). */
export function Chip({ table, code, size = 'sm' }: { table: Readonly<Record<string, readonly [Tone, string]>>; code: string | undefined; size?: 'sm' | 'md' }) {
  const row = code !== undefined && Object.hasOwn(table, code) ? table[code]! : (['neutral', code ?? '—'] as const);
  return <StatusChip kind="generic" status={code ?? ''} tone={row[0]} label={row[1]} size={size} />;
}

export interface ListColumn<Row> extends ColumnDef<Row> {
  /** Phone card value; undefined = same as the table cell, null = left out of the card (actions live on the detail screen). */
  card?: (r: Row) => ReactNode | null;
}
export interface ListScreenProps<Row> {
  caption: string;
  columns: readonly ListColumn<Row>[];
  rows: readonly Row[];
  getRowId: (r: Row) => string;
  /** Row open (Enter / double click). */
  href?: (r: Row) => string;
  /** Row open without navigation (e.g. a detail Drawer); wins over href. */
  onOpen?: (r: Row) => void;
  empty: EmptyStateProps;
  nextCursor?: string | undefined;
  cardActions?: (r: Row) => ReactNode;
  rowActions?: (r: Row) => readonly { id: string; label: string; isDanger?: boolean }[];
  onRowActionMenu?: (r: Row, actionId: string) => void;
  /** Desktop multi-select with bulk actions (cards have none). */
  selection?: NonNullable<DataTableProps<Row>['selection']>;
  bulkActions?: DataTableProps<Row>['bulkActions'];
  onBulkAction?: DataTableProps<Row>['onBulkAction'];
}

/** 04-UI-UX §7: every table has a caption; on phones the same rows render as a card list, the row-header field first. */
export function ListScreen<Row>({ caption, columns, rows, getRowId, href, onOpen, empty, nextCursor, cardActions, rowActions, onRowActionMenu, selection, bulkActions, onBulkAction }: ListScreenProps<Row>) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  if (rows.length === 0) return <EmptyState {...empty} />;
  const go = (cursor: string | undefined) => {
    const p = new URLSearchParams(sp?.toString() ?? '');
    if (cursor) p.set('cursor', cursor);
    else p.delete('cursor');
    const s = p.toString();
    router.push(s ? `${pathname}?${s}` : pathname);
  };
  const head = columns.find((c) => c.isRowHeader) ?? columns[0]!;
  return (
    <>
      <div className="partner-table">
        <DataTable
          caption={caption}
          columns={columns}
          rows={rows}
          getRowId={getRowId}
          emptyState={empty}
          {...(onOpen ? { onRowAction: onOpen } : href ? { onRowAction: (r: Row) => router.push(href(r)) } : {})}
          {...(rowActions ? { rowActions } : {})}
          {...(onRowActionMenu ? { onRowActionMenu } : {})}
          {...(selection ? { selection } : {})}
          {...(bulkActions ? { bulkActions } : {})}
          {...(onBulkAction ? { onBulkAction } : {})}
          page={{ hasNext: !!nextCursor, hasPrevious: !!sp?.get('cursor'), onNext: () => go(nextCursor), onPrevious: () => router.back(), limit: rows.length }}
        />
      </div>
      <div className="partner-cards" data-view="cards" role="list" aria-label={caption}>
        {rows.map((r) => (
          <div key={getRowId(r)} role="listitem">
            <Card>
              <div className="partner-card-head">{head.cell(r)}</div>
              <DescriptionList
                items={columns
                  .filter((c) => c !== head)
                  .flatMap((c) => {
                    const v = c.card ? c.card(r) : c.cell(r);
                    return v === null || v === undefined || v === '' ? [] : [{ term: c.header, value: v }];
                  })}
              />
              {cardActions ? <div className="partner-card-actions">{cardActions(r)}</div> : null}
            </Card>
          </div>
        ))}
      </div>
    </>
  );
}

/** A row-header link (real anchor so a row is openable without JS and by middle-click). */
export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href}>{children}</Link>;
}

/** Push the filter state to the URL (non-PHI filters only; patient search never comes through here: REQ-SEC-098). */
export function useApplyFilters() {
  const router = useRouter();
  const pathname = usePathname();
  return (params: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    const s = p.toString();
    router.push(s ? `${pathname}?${s}` : pathname);
  };
}
