'use client';
// S1 Inventory home (04-UI-UX §3 S1). LD-140 (2026-11-13): kit components only; ONE primary button (first of New PO / Receive goods the user may use);
// status = tone + icon + word. All labels (store code, item code, lot no.) are resolved on the server; no ids or tokens are needed here.
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Grid } from '@lims/ui/components/Grid';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { StatTile } from '@lims/ui/components/StatTile';
import type { Alert } from '../server/types';
import { ALERT_KIND_LABEL } from './codes';
import { Chip, isoDate } from './shared';

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
  checklist: readonly { label: string; done: boolean }[];
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
        <DataTable
          caption="Newest open alerts"
          columns={columns}
          rows={p.rows}
          getRowId={(r) => r.alert.id}
          emptyState={{ title: 'No open alerts.' }}
        />
        <a className="lims-link" href="/inventory/alerts">
          View all alerts
        </a>
        {allDone ? null : (
          <Card title="Set-up checklist">
            <Stack gap={2}>
              {p.checklist.map((c) => (
                <Inline key={c.label} justify="between">
                  <span>{c.label}</span>
                  <Chip tone={c.done ? 'success' : 'neutral'} label={c.done ? 'Done' : 'To do'} />
                </Inline>
              ))}
            </Stack>
          </Card>
        )}
      </Stack>
    </section>
  );
}
