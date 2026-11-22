'use client';
// /lab/ingest-exceptions (04-UI-UX §3.10, route staff.lab.ingest_exceptions, CR-C7-014): read-only queue of instrument results that could not be applied (AC-14.3).
// No raw value and nothing patient-linked in the URL (REQ-SEC-028): filters carry status / reason only. Actions live on the detail screen.
// T0D-UICONSOLE-1 (LD-353 template 2 CONSOLE): PageHeader, one FilterBar (Reason, Status), StatTiles (Open, Resolved, Oldest age) above a SplitConsole: queue at left (Age first,
// API order), detail at right (the facts of the row plus History), bar = the existing link to the detail screen. No Re-apply / Assign / Discard here; raw value, flags and unit never shown (P3).
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SplitConsole } from '@lims/ui/components/SplitConsole';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { t } from '@/core/i18n/messages';
import { EXCEPTION_REASONS, EXCEPTION_STATUSES, type IngestException } from '../server/types';
import { REASON_TEXT } from './exceptionText';
import { Facts, History, OpenBar, OpenKey, hhmm, oldest, useNow, when } from './consoleParts';

export interface IngestExceptionListProps { items: readonly IngestException[]; permissions?: readonly string[]; status?: string; nextCursor?: string }

const HEADERS = ['Age', 'Barcode', 'Reason', 'Instrument code', 'Instrument', 'Status'];
const href = (id: string) => `/lab/ingest-exceptions/${encodeURIComponent(id)}`;
const reasonText = (r: string) => REASON_TEXT[r] ?? r;

export function IngestExceptionList({ items, status = 'open', nextCursor }: IngestExceptionListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = useNow();
  const [selectedId, setSelectedId] = useState<string>();
  const title = t('lab.nav.ingest_exceptions');
  const value: FilterValue = { reason: params.get('reason') ?? undefined, status: params.get('status') ?? status };
  const go = (v: FilterValue) => {
    const q = new URLSearchParams(params.toString());
    q.delete('cursor');   // a new filter starts at the first page
    for (const key of ['reason', 'status'] as const) { const x = v[key]; if (typeof x === 'string' && x) q.set(key, x); else q.delete(key); }
    router.push(q.size ? `${pathname}?${q}` : pathname);
  };
  const more = (() => { const q = new URLSearchParams(params.toString()); if (nextCursor) q.set('cursor', nextCursor); return `${pathname}?${q}`; })();
  const age = (e: IngestException) => (e.status !== 'open' && e.resolved_at ? Date.parse(e.resolved_at) : now) - Date.parse(e.created_at);
  const open = items.filter((e) => e.status === 'open');
  const sel = items.find((e) => e.id === selectedId);

  // T0D-UIX-3 (LD-442): the queue is the kit DataTable; consoleSelection keeps the SplitConsole row selection (data-console-item, aria-selected).
  const columns: ColumnDef<IngestException>[] = [
    { id: 'age', header: HEADERS[0]!, numeric: true, cell: (e) => <span suppressHydrationWarning>{hhmm(age(e))}</span> },
    { id: 'barcode', header: HEADERS[1]!, isRowHeader: true, cell: (e) => <Link href={href(e.id)}>{e.sample_barcode ?? 'No barcode'}</Link> },
    { id: 'reason', header: HEADERS[2]!, cell: (e) => reasonText(e.reason) },
    { id: 'code', header: HEADERS[3]!, cell: (e) => e.instrument_analyte_code ?? '' },
    // T0D-UIX-3 ruling round 2 point 2b (04-UI-UX §3.10 "C7 name or IdText"): display only, from the existing instrument_id.
    { id: 'instrument', header: HEADERS[4]!, cell: (e) => (e.instrument_id ? <IdText value={e.instrument_id} /> : '') },
    { id: 'status', header: HEADERS[5]!, cell: (e) => e.status },
  ];
  const list = (
    <DataTable caption={title} columns={columns} rows={items} getRowId={(e) => e.id} emptyState={{ title: `No ${status} instrument exceptions.` }}
      consoleSelection={{ selectedId, onSelect: setSelectedId }} />
  );

  const detail = sel ? (
    <>
      {/* T0D-UIGUARD-1-LAB (LD-436 rule 7): heading semantics without a raw h2 */}
      <p role="heading" aria-level={2} className="lims-card-title">{reasonText(sel.reason)}</p>
      <Facts items={[
        ['Status', sel.status],
        ['Barcode', sel.sample_barcode ?? 'No barcode'],
        ['Instrument code', sel.instrument_analyte_code ?? ''],
        ['Instrument', sel.instrument_id ?? ''],
        ['Received', when(sel.created_at)],
      ]} />
      <History events={[
        ['Received', sel.created_at] as const,
        ...(sel.status !== 'open' && sel.resolved_at ? [[sel.status === 'discarded' ? 'Discarded' : 'Resolved', sel.resolved_at] as const] : []),
      ]} />
    </>
  ) : <p>Select an exception to see it here.</p>;

  return (
    <section aria-label={title}>
      <PageHeader title={title} helpKey="lab.ingest_exceptions" />
      <FilterBar
        filters={[
          { id: 'reason', label: 'Reason', kind: 'select', options: EXCEPTION_REASONS.map((r) => ({ value: r, label: reasonText(r) })) },
          { id: 'status', label: 'Status', kind: 'select', options: EXCEPTION_STATUSES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })) }, // sentence case (LD-353 rule 3)
        ]}
        value={value}
        onChange={go}
        onReset={() => go({})}
      />
      <StatTileRow>
        <StatTile label="Open" value={String(open.length)} />
        <StatTile label="Resolved" value={String(items.filter((e) => e.status === 'resolved').length)} />
        <StatTile label="Oldest age" value={oldest(open.map(age))} />
      </StatTileRow>
      <OpenKey href={sel ? href(sel.id) : undefined}>
        <SplitConsole list={list} detail={detail} listLabel="Exception queue" detailLabel="Instrument exception"
          actions={sel ? <OpenBar href={href(sel.id)} label="Open exception" /> : undefined} />
      </OpenKey>
      {nextCursor ? <p><Link href={more}>Next page</Link></p> : null}
    </section>
  );
}
