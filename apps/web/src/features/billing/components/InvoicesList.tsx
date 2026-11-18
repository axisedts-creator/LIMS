'use client';
// 04-UI-UX §8.1 Invoices list. Filters: FY (B.S.), date range, centre, status, invoice no, credit party. Columns carry both B.S. and A.D. dates.
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useRouter } from 'next/navigation';
import type { InvoiceSummary } from '../server/types';
import { Ad, InvoiceStatus, amount, cbmsLabel } from './format';
import type { ListFailure } from './listRead';
import { useUrlFilters } from './useUrlFilters';

export interface Centre { id: string; name: string }

/** T0D-UILIST-2 (LD-353 rule 5): the header row NotAvailable draws while listInvoices is pending. */
export const INVOICE_COLUMNS = ['Invoice no', 'B.S. date', 'A.D. date', 'Buyer', 'Net (NPR)', 'Status', 'Prints', 'CBMS'] as const;

export function InvoicesList({ invoices, centres, failure }: { invoices: readonly InvoiceSummary[]; permissions: readonly string[]; centres: readonly Centre[]; failure?: ListFailure }) {
  const router = useRouter();
  const f = useUrlFilters(['fiscal_year_bs', 'date_range', 'centre_id', 'status', 'invoice_no', 'credit_party_id']);
  const columns: ColumnDef<InvoiceSummary>[] = [
    { id: 'invoice_no', header: 'Invoice no', isRowHeader: true, sortKey: 'invoice_seq', cell: (i) => <a className="lims-link" href={`/billing/invoices/${i.id}`}>{i.invoice_no}</a> },
    { id: 'bs', header: 'B.S. date', cell: (i) => i.invoice_date_bs },
    { id: 'ad', header: 'A.D. date', sortKey: 'issued_at', cell: (i) => <Ad value={i.issued_at} /> },
    { id: 'buyer', header: 'Buyer', cell: (i) => i.buyer_name ?? '—' },
    // LD-353 rule 3, done_when (7): money right aligned, two decimals, the currency in the header
    { id: 'net', header: 'Net (NPR)', numeric: true, cell: (i) => amount(i.net) },
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
      <DataTable caption="Invoices" columns={columns} rows={invoices} getRowId={(i) => i.id} sort={{ value: f.sort ?? '-issued_at', onChange: f.onSort }} emptyState={{ title: 'No invoices match these filters.' }} cellTitle
        {...(failure ? { error: { title: 'Invoices could not be loaded', ...failure, onRetry: () => router.refresh() } } : {})} />
    </section>
  );
}
