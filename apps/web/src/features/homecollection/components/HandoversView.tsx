'use client';
// 04-UI-UX §2.3 W3 Tube handovers (list). Plain-JSON props from the server page; the drawer loads one handover (H14) and confirms it (H15) through server actions.
// LD-140: kit components only; one primary button per page (none here: the drawer carries it); every status shows tone, icon and word.
// Names and tube counts only: no visit, phone or address is read on this screen (08 A19 D-125).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Icon } from '@lims/ui/components/Icon';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
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

  const go = (o: { status?: string; centreId?: string; cursor?: string }) => {
    const p = new URLSearchParams();
    p.set('status', o.status ?? status);
    const c = o.centreId ?? centreId;
    if (c) p.set('centre_id', c);
    if (o.cursor) p.set('cursor', o.cursor);
    return `${BASE}?${p.toString()}`;
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
      <PageHeader
        title="Tube handovers" helpKey="homecollection.handovers"
        actions={
          <Inline gap={2} align="end">
            <Select
              label="Status" name="status" options={STATUS_OPTIONS} {...(STATUS_OPTIONS.some((o) => o.value === status) ? { value: status as (typeof STATUS_OPTIONS)[number]['value'] } : {})}
              onChange={(s) => router.replace(go({ status: s }))}
            />
            {centres.length ? <Select label="Centre" name="centre_id" options={centres.map((c) => ({ value: c.id, label: c.name }))} {...(centreId ? { value: centreId } : {})} onChange={(c) => router.replace(go({ centreId: c }))} /> : null}
            <Button onPress={() => router.refresh()}>Refresh</Button>
          </Inline>
        }
      />
      <DataTable<HandoverSummary>
        caption="Tube handovers" columns={columns} rows={handovers} getRowId={(h) => h.id} density="compact"
        emptyState={{ title: 'No handovers waiting at this centre.' }}
        onRowAction={(h) => setOpen(h)}
        {...(nextCursor ? { page: { hasNext: true, hasPrevious: false, onNext: () => router.push(go({ cursor: nextCursor })), onPrevious: () => router.back(), limit: 50 } } : {})}
      />
      {open ? <HandoverDrawer key={`${open.id}:${open.version}`} handover={open} isOpen onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
