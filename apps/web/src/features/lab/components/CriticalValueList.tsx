'use client';
// /lab/critical-values (C5 04-UI-UX §1 + §3.9, route staff.lab.critical_values, lab.critical_value.read). LD-255 (FOUNDER): lab staff and the administrator reach the list from the menu.
// T0D-UICONSOLE-1 (LD-353 template 2 CONSOLE): PageHeader, one FilterBar (the Status URL filter the page already reads), StatTiles (Open, Acknowledged, Oldest age) above a SplitConsole:
// queue at left (Age since detected first, open rows first), detail at right (direction, status, Detected at, Time to acknowledge, History), bar = the existing link to the record.
// No new action. The result value is not shown here (it is shown on the detail, which logs the access). Reg no, patient and notifications count are not in the DTO: gaps in the task notes.
// [CONV] a closed event's age stops at closed_at instead of running on.
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SplitConsole } from '@lims/ui/components/SplitConsole';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { t } from '@/core/i18n/messages';
import type { CriticalValueRow as ServerRow } from '../server/adminpages.server';

// C5 05-SCHEMA critical log column, shown as the time to acknowledge when the API sends it. Typed here because features/lab/server is pinned by rs-c5.static (LD-140).
type CriticalValueRow = ServerRow & { first_confirmed_notification_at?: string };
import { Facts, History, OpenBar, OpenKey, hhmm, oldest, useNow, when } from './consoleParts';

const DIRECTION: Record<CriticalValueRow['direction'], string> = { high: 'Critical high', low: 'Critical low', abnormal: 'Abnormal' };
const STATUS: Record<CriticalValueRow['status'], string> = { open: 'Open', notified: 'Notified', closed: 'Closed' };
const CRITICAL_STATUSES = Object.keys(STATUS) as CriticalValueRow['status'][]; // the server list (adminpages.server) is server-only
const HEADERS = ['Age since detected', 'Detected at', 'Analyte', 'Direction', 'Status']; // C5 04-UI-UX 3.9 keeps Detected at in the list (arbiter ruling T0D-UICONSOLE-1)
const href = (id: string) => `/lab/critical-values/${encodeURIComponent(id)}`;

export function CriticalValueList({ items, status, nextCursor }: { items: readonly CriticalValueRow[]; status?: string | undefined; nextCursor?: string | undefined }) {
  const now = useNow();
  const router = useRouter();
  const pathname = usePathname() ?? '/lab/critical-values';
  const [selectedId, setSelectedId] = useState<string>();
  const title = t('lab.nav.critical_values');
  const rows = [...items.filter((r) => r.status === 'open'), ...items.filter((r) => r.status !== 'open')];
  const age = (r: CriticalValueRow) => (r.closed_at ? Date.parse(r.closed_at) : now) - Date.parse(r.detected_at);
  const open = rows.filter((r) => r.status === 'open');
  const sel = rows.find((r) => r.id === selectedId);
  const more = `/lab/critical-values?${new URLSearchParams({ ...(status ? { status } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) })}`;
  const goStatus = (v: string | undefined) => router.push(v ? `${pathname}?${new URLSearchParams({ status: v })}` : pathname);

  // T0D-UIX-3 (LD-442): the queue is the kit DataTable; consoleSelection keeps the SplitConsole row selection (data-console-item, aria-selected).
  const columns: ColumnDef<CriticalValueRow>[] = [
    { id: 'age', header: HEADERS[0]!, numeric: true, cell: (r) => <span suppressHydrationWarning>{hhmm(age(r))}</span> },
    { id: 'detected', header: HEADERS[1]!, cell: (r) => when(r.detected_at) },
    { id: 'analyte', header: HEADERS[2]!, isRowHeader: true, cell: (r) => <Link href={href(r.id)}>{r.analyte_code}</Link> },
    { id: 'direction', header: HEADERS[3]!, cell: (r) => DIRECTION[r.direction] ?? r.direction },
    { id: 'status', header: HEADERS[4]!, cell: (r) => STATUS[r.status] ?? r.status },
  ];
  const list = (
    <DataTable caption={title} columns={columns} rows={rows} getRowId={(r) => r.id} emptyState={{ title: 'No critical values.' }}
      consoleSelection={{ selectedId, onSelect: setSelectedId }} />
  );

  const ack = sel?.first_confirmed_notification_at;
  const detail = sel ? (
    <>
      {/* T0D-UIGUARD-1-LAB (LD-436 rule 7): heading semantics without a raw h2 */}
      <p role="heading" aria-level={2} className="lims-card-title">{sel.analyte_code}</p>
      <Facts items={[
        ['Direction', DIRECTION[sel.direction] ?? sel.direction],
        ['Status', STATUS[sel.status] ?? sel.status],
        ['Detected at', when(sel.detected_at)],
        ['Time to acknowledge', ack ? hhmm(Date.parse(ack) - Date.parse(sel.detected_at)) : 'Not acknowledged yet'],
      ]} />
      <History events={[
        ['Detected', sel.detected_at] as const,
        ...(ack ? [['Acknowledged', ack] as const] : []),
        ...(sel.closed_at ? [['Closed', sel.closed_at] as const] : []),
      ]} />
    </>
  ) : <p>Select a critical value to see it here.</p>;

  return (
    <section aria-label={title}>
      <PageHeader title={title} helpKey="lab.critical_values" />
      <FilterBar
        filters={[{ id: 'status', label: 'Status', kind: 'select', options: CRITICAL_STATUSES.map((s) => ({ value: s, label: STATUS[s] })) }]}
        value={{ status }}
        onChange={(v) => goStatus(typeof v['status'] === 'string' ? v['status'] : undefined)}
        onReset={() => goStatus(undefined)}
      />
      <StatTileRow>
        <StatTile label="Open" value={String(open.length)} />
        <StatTile label="Acknowledged" value={String(rows.filter((r) => r.status === 'notified').length)} />
        <StatTile label="Oldest age" value={oldest(open.map(age))} />
      </StatTileRow>
      <OpenKey href={sel ? href(sel.id) : undefined}>
        <SplitConsole list={list} detail={detail} listLabel="Critical value queue" detailLabel="Critical value"
          actions={sel ? <OpenBar href={href(sel.id)} label="Open critical value" /> : undefined} />
      </OpenKey>
      {nextCursor ? <p><Link href={more}>Next page</Link></p> : null}
    </section>
  );
}
