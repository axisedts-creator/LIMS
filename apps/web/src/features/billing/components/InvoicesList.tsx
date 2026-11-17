'use client';
// 04-UI-UX §8.1 Invoices list. Filters: FY (B.S.), date range, centre, status, invoice no, credit party. Columns carry both B.S. and A.D. dates.
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { InvoiceSummary } from '../server/types';
import { Ad, InvoiceStatus, cbmsLabel, npr } from './format';
import { useUrlFilters } from './useUrlFilters';

export interface Centre { id: string; name: string }

export function InvoicesList({ invoices, centres }: { invoices: readonly InvoiceSummary[]; permissions: readonly string[]; centres: readonly Centre[] }) {
  const f = useUrlFilters(['fiscal_year_bs', 'date_range', 'centre_id', 'status', 'invoice_no', 'credit_party_id']);
  const columns: ColumnDef<InvoiceSummary>[] = [
    { id: 'invoice_no', header: 'Invoice no', isRowHeader: true, sortKey: 'invoice_seq', cell: (i) => <a className="lims-link" href={`/billing/invoices/${i.id}`}>{i.invoice_no}</a> },
    { id: 'bs', header: 'B.S. date', cell: (i) => i.invoice_date_bs },
    { id: 'ad', header: 'A.D. date', sortKey: 'issued_at', cell: (i) => <Ad value={i.issued_at} /> },
    { id: 'buyer', header: 'Buyer', cell: (i) => i.buyer_name ?? '—' },
    { id: 'net', header: 'Net', align: 'end', cell: (i) => npr(i.net) },
    { id: 'status', header: 'Status', cell: (i) => <InvoiceStatus status={i.status} /> },
    { id: 'prints', header: 'Prints', align: 'end', cell: (i) => (i.print_count === undefined ? '—' : String(i.print_count)) },
    { id: 'cbms', header: 'CBMS', cell: (i) => cbmsLabel(i.cbms_state) },
  ];
  return (
    <section aria-label="Invoices">
      <PageHeader title="Invoices" helpKey="billing.invoices" />
      <FilterBar
        filters={[
          { id: 'fiscal_year_bs', label: 'Fiscal year (B.S.), e.g. 2083/84', kind: 'text', maxLength: 9 },
          { id: 'date_range', label: 'Date range', kind: 'date_range' },
          { id: 'centre_id', label: 'Centre', kind: 'select', options: centres.map((c) => ({ value: c.id, label: c.name })) },
          { id: 'status', label: 'Status', kind: 'select', options: [{ value: 'issued', label: 'Issued invoices' }, { value: 'cancelled', label: 'Cancelled invoices' }] },
          { id: 'invoice_no', label: 'Invoice no', kind: 'text', maxLength: 64 },
          { id: 'credit_party_id', label: 'Credit party', kind: 'text', maxLength: 36 }, // [CONV] id entry until a credit-party search is wired (open point)
        ]}
        value={f.value}
        onChange={f.onChange}
        onReset={f.onReset}
      />
      <DataTable caption="Invoices" columns={columns} rows={invoices} getRowId={(i) => i.id} sort={{ value: f.sort ?? '-issued_at', onChange: f.onSort }} emptyState={{ title: 'No invoices match these filters.' }} />
    </section>
  );
}
