'use client';
// S1 Inventory home (04-UI-UX §3 S1). LD-140 (2026-11-13): kit components only; ONE primary button (first of New PO / Receive goods the user may use);
// status = tone + icon + word. All labels (store code, item code, lot no.) are resolved on the server; no ids or tokens are needed here.
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { Grid } from '@lims/ui/components/Grid';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { StatTile } from '@lims/ui/components/StatTile';
import type { Alert } from '../server/types';
import { ALERT_KIND_LABEL } from './codes';
import { Chip, isoDate, useLocalFilters } from './shared';

export interface HomeAlertRow { alert: Alert; store: string; item: string; lot: string }
export interface HomeProps {
  /** Counts as display text ("3", or "200+" when the API page was full). */
  counts: { belowReorder: string; expiring: string; expired: string; waiting: string };
  expiryDays: number;
  consumptionOn: boolean;
  canManageSettings: boolean;
  canNewPo: boolean;
  canReceive: boolean;
  rows: readonly HomeAlertRow[];
  /** failed = the probe failed (request id, '' when none): the step shows the failure, not "To do". */
  checklist: readonly { label: string; done: boolean; failed?: string | undefined }[];
}

const OFF_COPY = 'Automatic consumption is off. Stock is not deducted for tests, QC or reruns until a manager turns it on in Settings.';

export function InventoryHome(p: HomeProps) {
  const router = useRouter();
  const columns: ColumnDef<HomeAlertRow>[] = [
    { id: 'kind', header: 'Kind', isRowHeader: true, cell: (r) => ALERT_KIND_LABEL[r.alert.alert_kind] },
    { id: 'store', header: 'Store', cell: (r) => r.store },
    { id: 'item', header: 'Item', cell: (r) => r.item },
    { id: 'lot', header: 'Lot', cell: (r) => r.lot },
    { id: 'raised', header: 'Raised', cell: (r) => isoDate(r.alert.last_raised_at) },
    { id: 'occurrences', header: 'Occurrences', align: 'end', cell: (r) => String(r.alert.occurrences) },
  ];
  const actions = (
    <Inline>
      {p.canReceive ? (
        <Button variant={p.canNewPo ? 'secondary' : 'primary'} onPress={() => router.push('/inventory/receipts')}>
          Receive goods
        </Button>
      ) : null}
      {p.canNewPo ? (
        <Button variant="primary" onPress={() => router.push('/inventory/purchase-orders')}>
          New PO
        </Button>
      ) : null}
    </Inline>
  );
  const allDone = p.checklist.every((c) => c.done);
  // T0D-UILIST-3 (LD-353 template 1): the landing's alert list has the same one FilterBar as the other inventory lists; it offers the kinds shown.
  const filters = useLocalFilters(p.rows, { kind: (r, v) => r.alert.alert_kind === v });

  return (
    <section aria-label="Inventory">
      <PageHeader title="Inventory" helpKey="inventory.home" {...(p.canNewPo || p.canReceive ? { actions } : {})} />
      <Stack>
        <Grid columns={4}>
          <StatTile label="Below reorder" value={p.counts.belowReorder} href="/inventory/alerts?alert_kind=below_reorder" />
          <StatTile label={`Expiring in ${p.expiryDays} days`} value={p.counts.expiring} href="/inventory/alerts?alert_kind=expiry_soon" />
          <StatTile label="Expired on hand" value={p.counts.expired} href="/inventory/alerts?alert_kind=expired_on_hand" />
          <StatTile label="Waiting consumption" value={p.counts.waiting} href="/inventory/unresolved" />
        </Grid>
        {p.consumptionOn ? null : (
          <Banner tone="warning" title={OFF_COPY} {...(p.canManageSettings ? { action: { label: 'Open settings', onPress: () => router.push('/inventory/settings') } } : {})} />
        )}
        <FilterBar
          filters={[{ id: 'kind', label: 'Kind', kind: 'select', options: [...new Set(p.rows.map((r) => r.alert.alert_kind))].map((value) => ({ value, label: ALERT_KIND_LABEL[value] })) }]}
          value={filters.value}
          onChange={filters.onChange}
          onReset={filters.onReset}
        />
        <DataTable
          caption="Newest open alerts"
          columns={columns}
          rows={filters.shown}
          getRowId={(r) => r.alert.id}
          cellTitle
          emptyState={{ title: 'No open alerts.' }}
        />
        <a className="lims-link" href="/inventory/alerts">
          View all alerts
        </a>
        {allDone ? null : (
          <Card title="Set-up checklist">
            <Stack gap={2}>
              {p.checklist.map((c) =>
                // T0D-FIX-9 (LD-455): a probe that failed is shown with its reference, never as a plain "To do"
                c.failed !== undefined ? (
                  <div key={c.label} role="alert">
                    <Inline justify="between">
                      <span>{c.label}</span>
                      <Chip tone="danger" label="Could not check" />
                    </Inline>
                    {c.failed ? <p className="lims-description">{`Reference: ${c.failed}`}</p> : null}
                  </div>
                ) : (
                  <Inline key={c.label} justify="between">
                    <span>{c.label}</span>
                    <Chip tone={c.done ? 'success' : 'neutral'} label={c.done ? 'Done' : 'To do'} />
                  </Inline>
                ),
              )}
            </Stack>
          </Card>
        )}
      </Stack>
    </section>
  );
}
