'use client';
// 04-UI-UX §8.4 Dues. Patient is masked by the API; no PHI beyond that is shown. The registration no opens the order's billing tab.
// T0D-UIDASH-1 (LD-353 template 5): StatTiles Total due and Oldest, the "Dues by age" bar and the Centre filter work on the rows already on the screen
// (no new operation). Party: DueRow carries no party, so the Party control has no options yet (contract request in the task notes).
import { useState } from 'react';
import { BarChart } from '@lims/ui/components/BarChart';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { t } from '@/core/i18n/messages';
import type { DueRow } from '../server/types';
import { ageDays, formatNpr, npr } from './format';

const formatPaisa = (paisa: number) => (paisa < 0 ? '-' : '') + formatNpr(Math.abs(paisa)).replace(/^NPR /, '');

const BUCKETS = [
  { label: '0-30 days', max: 30 },
  { label: '31-60 days', max: 60 },
  { label: '61-90 days', max: 90 },
  { label: '90+ days', max: Infinity },
] as const;

export function DuesList({ dues, centres = [] }: { dues: readonly DueRow[]; centres?: readonly { id: string; name: string }[] }) {
  const [now] = useState(() => Date.now());
  const [filter, setFilter] = useState<FilterValue>({});
  const centreName = new Map(centres.map((c) => [c.id, c.name]));
  const centre = typeof filter['centre'] === 'string' ? filter['centre'] : undefined;
  const rows = centre ? dues.filter((d) => d.centre_id === centre) : dues;
  const columns: ColumnDef<DueRow>[] = [
    { id: 'reg', header: 'Registration no', isRowHeader: true, cell: (d) => <a className="lims-link" href={`/frontdesk/orders/${d.order_id}?tab=billing`}>{d.registration_no}</a> },
    { id: 'patient', header: 'Patient', cell: (d) => d.patient_display },
    // 07-SECURITY: a centre id is never rendered; an unknown centre shows a dash
    { id: 'centre', header: 'Centre', cell: (d) => centreName.get(d.centre_id) ?? '—' },
    { id: 'invoiced', header: 'Invoiced', align: 'end', cell: (d) => npr(d.invoiced) },
    { id: 'paid', header: 'Paid', align: 'end', cell: (d) => npr(d.paid) },
    { id: 'credited', header: 'Credited', align: 'end', cell: (d) => npr(d.credited) },
    { id: 'due', header: 'Due', align: 'end', cell: (d) => npr(d.balance_due) },
    { id: 'age', header: 'Oldest invoice age', align: 'end', cell: (d) => (d.oldest_invoice_at ? `${ageDays(d.oldest_invoice_at, now)} days` : '—') },
  ];
  const total = rows.reduce((sum, d) => sum + d.balance_due.amount_paisa, 0);
  const ages = rows.flatMap((d) => (d.oldest_invoice_at ? [ageDays(d.oldest_invoice_at, now)] : []));
  // no invented ages: one row without oldest_invoice_at and the aging bar is NotAvailable
  const canAge = ages.length === rows.length;
  const bucketOf = (days: number) => BUCKETS.findIndex((b) => days <= b.max);
  const aged = BUCKETS.map((_, i) => rows.filter((d) => d.oldest_invoice_at && bucketOf(ageDays(d.oldest_invoice_at, now)) === i).reduce((sum, d) => sum + d.balance_due.amount_paisa, 0));
  return (
    <section aria-label="Dues">
      <PageHeader title={t('nav.billing.dues')} helpKey="billing.dues" />
      <FilterBar
        filters={[
          { id: 'centre', label: 'Centre', kind: 'select', options: centres.map((c) => ({ value: c.id, label: c.name })) },
          { id: 'party', label: 'Party', kind: 'select', options: [] },
        ]}
        value={filter}
        onChange={setFilter}
        onReset={() => setFilter({})}
      />
      <StatTileRow>
        {/* [CONV] the currency is its own span (LD-353 rule 3), so the tile reads "NPR 630.00" while the amount text stays apart from the row cells */}
        <div className="lims-stat">
          <span className="lims-stat-label">Total due</span>
          <span className="lims-stat-value"><span>NPR</span> {formatPaisa(total)}</span>
        </div>
        <StatTile label="Oldest" value={ages.length ? `${Math.max(...ages)} days` : '—'} />
      </StatTileRow>
      <ChartCard title="Dues by age" isEmpty={canAge && rows.length === 0}>
        {canAge ? (
          <BarChart title="Dues by age" valueFormat="money" categories={BUCKETS.map((b) => b.label)} series={[{ id: 'due', label: 'Amount', values: aged }]} />
        ) : (
          <div className="lims-state">
            <p className="lims-state-title">Not available yet</p>
            <p className="lims-state-body">Some dues carry no invoice date, so they cannot be aged yet.</p>
          </div>
        )}
      </ChartCard>
      <DataTable caption="Outstanding dues" columns={columns} rows={rows} getRowId={(d) => d.order_id} emptyState={{ title: 'No outstanding dues.' }} />
    </section>
  );
}
