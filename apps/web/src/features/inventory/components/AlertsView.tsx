'use client';
// S16 Alerts (04-UI-UX §3 S16; TRD #90, #91). LD-140 (2026-11-13): kit components only; status = tone + icon + word; no primary button on this page.
// Acknowledge sends If-Match "<version>" through a server action (the token stays on the server). A hidden (404) or forbidden (403) alert
// shows the registry title with the request id and never claims success. One request per row at a time.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { useToast } from '@lims/ui/components/Toast';
import { acknowledgeAlertAction } from '../server/actions';
import { ALERT_STATUSES, type Alert } from '../server/types';
import { ALERT_KIND_LABEL, ALERT_STATUS_CHIP } from './codes';
import { Chip, isoDate, ProblemBanner, useUrlFilters, type Failure } from './shared';

export interface AlertRow { alert: Alert; store: string; item: string; lot: string }

export function AlertsView({ rows, stores, canAcknowledge }: { rows: readonly AlertRow[]; stores: readonly { value: string; label: string }[]; canAcknowledge: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState<string>();
  const [problem, setProblem] = useState<Failure>();
  const busy = useRef(false);
  // Rows acknowledged in this session: shown as Acknowledged (no second button) until router.refresh() brings the new version.
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const filters = useUrlFilters(['alert_kind', 'status', 'store_id']);

  const acknowledge = async (a: Alert) => {
    if (busy.current) return;
    busy.current = true;
    setPending(a.id);
    setProblem(undefined);
    try {
      const r = await acknowledgeAlertAction(a.id, a.version);
      if (!r.ok) return setProblem(r);
      setAcked((cur) => new Set(cur).add(a.id));
      toast.show({ tone: 'success', title: 'Alert acknowledged' });
      router.refresh();
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  };

  const columns: ColumnDef<AlertRow>[] = [
    { id: 'kind', header: 'Kind', isRowHeader: true, cell: (r) => ALERT_KIND_LABEL[r.alert.alert_kind] },
    { id: 'store', header: 'Store', cell: (r) => r.store },
    { id: 'item', header: 'Item', cell: (r) => r.item },
    { id: 'lot', header: 'Lot', cell: (r) => r.lot },
    { id: 'first', header: 'First raised', cell: (r) => isoDate(r.alert.first_raised_at) },
    { id: 'last', header: 'Last raised', cell: (r) => isoDate(r.alert.last_raised_at) },
    { id: 'occurrences', header: 'Occurrences', align: 'end', cell: (r) => String(r.alert.occurrences) },
    { id: 'status', header: 'Status', cell: (r) => <Chip {...ALERT_STATUS_CHIP[acked.has(r.alert.id) ? 'acknowledged' : r.alert.status]} /> },
    ...(canAcknowledge
      ? [
          {
            id: 'action',
            header: 'Action',
            cell: (r: AlertRow) =>
              r.alert.status === 'open' && !acked.has(r.alert.id) ? (
                <Button size="sm" isLoading={pending === r.alert.id} isDisabled={pending !== undefined} onPress={() => void acknowledge(r.alert)}>
                  Acknowledge
                </Button>
              ) : null,
          } satisfies ColumnDef<AlertRow>,
        ]
      : []),
  ];

  return (
    <section aria-label="Alerts">
      <PageHeader title="Alerts" helpKey="inventory.alerts" />
      <Stack>
        <FilterBar
          filters={[
            { id: 'alert_kind', label: 'Kind', kind: 'select', options: Object.entries(ALERT_KIND_LABEL).map(([value, label]) => ({ value, label })) },
            { id: 'status', label: 'Status', kind: 'select', options: ALERT_STATUSES.map((s) => ({ value: s, label: ALERT_STATUS_CHIP[s].label })) },
            { id: 'store_id', label: 'Store', kind: 'select', options: stores },
          ]}
          value={filters.value}
          onChange={filters.onChange}
          onReset={filters.onReset}
        />
        <ProblemBanner problem={problem} />
        <DataTable caption="Alerts" columns={columns} rows={rows} getRowId={(r) => r.alert.id} emptyState={{ title: 'No alerts.' }} />
      </Stack>
    </section>
  );
}
