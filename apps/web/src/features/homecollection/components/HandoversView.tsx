'use client';
// 04-UI-UX §2.3 W3 Tube handovers (list). Plain-JSON props from the server page; the drawer loads one handover (H14) and confirms it (H15) through server actions.
// LD-140: kit components only; one primary button per page (none here: the drawer carries it); every status shows tone, icon and word.
// Names and tube counts only: no visit, phone or address is read on this screen (08 A19 D-125).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useBoardRefresh } from '../hooks/useBoardRefresh';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Icon } from '@lims/ui/components/Icon';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { HANDOVER_STATUS, handoverStatus, toneIcon } from '../labels';
import { HANDOVER_STATUSES } from '../query';
import type { Centre, HandoverSummary } from '../types';
import { HandoverDrawer } from './HandoverDrawer';

type Iso = DateTextProps['value'];
const BASE = '/homecollection/handovers';
const STATUS_OPTIONS = HANDOVER_STATUSES.map((s) => ({ value: s, label: HANDOVER_STATUS[s]![1] }));

export interface HandoversViewProps {
  handovers: readonly HandoverSummary[];
  centres: readonly Centre[];
  centreId?: string | undefined;
  status: string;
  permissions: readonly string[];
  nextCursor?: string | undefined;
}

/** Word + tone + icon for a status: never colour alone. */
function StatusCell({ status }: { status: string }) {
  const [tone, label] = handoverStatus(status);
  return (
    <Inline gap={1}>
      <Icon name={toneIcon(tone)} />
      <StatusChip kind="generic" status={status} tone={tone} label={label} />
    </Inline>
  );
}

export function HandoversView({ handovers, centres, centreId, status, nextCursor }: HandoversViewProps) {
  const router = useRouter();
  const [open, setOpen] = useState<HandoverSummary | null>(null);
  useBoardRefresh(open !== null);

  const go = (o: { status?: string; centreId?: string; cursor?: string }) => {
    const p = new URLSearchParams();
    p.set('status', o.status ?? status);
    const c = o.centreId ?? centreId;
    if (c) p.set('centre_id', c);
    if (o.cursor) p.set('cursor', o.cursor);
    return `${BASE}?${p.toString()}`;
  };

  const filters: FilterDef[] = [
    { id: 'status', label: 'Status', kind: 'select', options: STATUS_OPTIONS },
    ...(centres.length ? [{ id: 'centre_id', label: 'Centre', kind: 'select' as const, options: centres.map((c) => ({ value: c.id, label: c.name })) }] : []),
  ];
  const onFilter = (v: FilterValue) => {
    const s = typeof v['status'] === 'string' ? v['status'] : status;
    const c = typeof v['centre_id'] === 'string' ? v['centre_id'] : centreId;
    if (s !== status || c !== centreId) router.replace(go({ status: s, ...(c ? { centreId: c } : {}) }));
  };

  const columns: ColumnDef<HandoverSummary>[] = [
    { id: 'at', header: 'Handed over at', cell: (h) => <DateText value={h.handed_over_at as Iso} withTime /> },
    { id: 'from', header: 'From', isRowHeader: true, cell: (h) => h.from.display_name },
    { id: 'tubes', header: 'Tubes', align: 'end', cell: (h) => String(h.item_count) },
    { id: 'status', header: 'Status', cell: (h) => <StatusCell status={h.status} /> },
    { id: 'open', header: 'Open', cell: (h) => <Button size="sm" variant="ghost" onPress={() => setOpen(h)}>Open</Button> },
  ];

  return (
    <div>
      <PageHeader title="Tube handovers" helpKey="homecollection.handovers" actions={<Button onPress={() => router.refresh()}>Refresh</Button>} />
      {/* T0D-UILIST-3, LD-353 template 1: the filters sit in one FilterBar under the header; Refresh stays in the header. */}
      <FilterBar filters={filters} value={{ ...(STATUS_OPTIONS.some((o) => o.value === status) ? { status } : {}), ...(centreId ? { centre_id: centreId } : {}) }} onChange={onFilter} onReset={() => router.replace(`${BASE}?status=pending`)} />
      <DataTable<HandoverSummary>
        caption="Tube handovers" columns={columns} rows={handovers} getRowId={(h) => h.id} density="compact" cellTitle
        emptyState={{ title: 'No handovers waiting at this centre.' }}
        onRowAction={(h) => setOpen(h)}
        {...(nextCursor ? { page: { hasNext: true, hasPrevious: false, onNext: () => router.push(go({ cursor: nextCursor })), onPrevious: () => router.back(), limit: 50 } } : {})}
      />
      {open ? <HandoverDrawer key={`${open.id}:${open.version}`} handover={open} isOpen onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
