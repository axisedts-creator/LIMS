'use client';
// 04-UI-UX §8.4 Dues. Patient is masked by the API; no PHI beyond that is shown. The registration no opens the order's billing tab.
import { useState } from 'react';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { DueRow } from '../server/types';
import { ageDays, npr } from './format';

export function DuesList({ dues, centres = [] }: { dues: readonly DueRow[]; centres?: readonly { id: string; name: string }[] }) {
  const [now] = useState(() => Date.now());
  const centreName = new Map(centres.map((c) => [c.id, c.name]));
  const columns: ColumnDef<DueRow>[] = [
    { id: 'reg', header: 'Registration no', isRowHeader: true, cell: (d) => <a className="lims-link" href={`/frontdesk/orders/${d.order_id}?tab=billing`}>{d.registration_no}</a> },
    { id: 'patient', header: 'Patient', cell: (d) => d.patient_display },
    { id: 'centre', header: 'Centre', cell: (d) => centreName.get(d.centre_id) ?? d.centre_id },
    { id: 'invoiced', header: 'Invoiced', align: 'end', cell: (d) => npr(d.invoiced) },
    { id: 'paid', header: 'Paid', align: 'end', cell: (d) => npr(d.paid) },
    { id: 'credited', header: 'Credited', align: 'end', cell: (d) => npr(d.credited) },
    { id: 'due', header: 'Due', align: 'end', cell: (d) => npr(d.balance_due) },
    { id: 'age', header: 'Oldest invoice age', align: 'end', cell: (d) => (d.oldest_invoice_at ? `${ageDays(d.oldest_invoice_at, now)} days` : '—') },
  ];
  return (
    <section aria-label="Dues">
      <PageHeader title="Dues" helpKey="billing.dues" />
      <DataTable caption="Outstanding dues" columns={columns} rows={dues} getRowId={(d) => d.order_id} emptyState={{ title: 'No outstanding dues.' }} />
    </section>
  );
}
