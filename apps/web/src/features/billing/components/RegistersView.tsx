'use client';
// 04-UI-UX §8.7 Registers (statutory): always B.S. AND A.D. date columns. Tabs: Sales register, Cancelled invoices, Credit notes.
// Export buttons (Excel, XML, PDF) only with billing.data.export.
import { useState } from 'react';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import type { CancelledInvoiceRow, CreditNoteRegisterRow, ExportKind, SalesRegisterRow } from '../server/types';
import { Ad, InvoiceStatus, hasPerm, humanize, npr } from './format';
import { ExportButtons } from './ExportButtons';
import { useUrlFilters } from './useUrlFilters';

type Tab = 'sales' | 'cancelled' | 'credit_notes';
const TABS: readonly { id: Tab; label: string; kind: ExportKind }[] = [
  { id: 'sales', label: 'Sales register', kind: 'sales_register' },
  { id: 'cancelled', label: 'Cancelled invoices', kind: 'cancelled_invoices' },
  { id: 'credit_notes', label: 'Credit notes', kind: 'credit_notes' },
];
const EMPTY = { title: 'No entries for the selected filters.' };

const sales: ColumnDef<SalesRegisterRow>[] = [
  { id: 'sn', header: 'SN', align: 'end', cell: (r) => String(r.sn) },
  { id: 'bs', header: 'B.S. date', cell: (r) => r.invoice_date_bs },
  { id: 'ad', header: 'A.D. date', cell: (r) => <Ad value={r.invoice_date_ad} /> },
  { id: 'no', header: 'Invoice no', isRowHeader: true, cell: (r) => r.invoice_no },
  { id: 'buyer', header: 'Buyer', cell: (r) => r.buyer_name ?? '—' },
  { id: 'pan', header: 'PAN', cell: (r) => r.buyer_pan ?? '—' },
  { id: 'total', header: 'Total', align: 'end', cell: (r) => npr(r.total) },
  { id: 'exempt', header: 'Exempt', align: 'end', cell: (r) => npr(r.exempt) },
  { id: 'taxable', header: 'Taxable', align: 'end', cell: (r) => npr(r.taxable) },
  { id: 'vat', header: 'VAT', align: 'end', cell: (r) => npr(r.vat) },
  { id: 'other', header: 'Other tax', align: 'end', cell: (r) => npr(r.other_tax) },
  { id: 'status', header: 'Status', cell: (r) => <InvoiceStatus status={r.status} /> },
];
const cancelledCols: ColumnDef<CancelledInvoiceRow>[] = [
  { id: 'sn', header: 'SN', align: 'end', cell: (r) => String(r.sn) },
  { id: 'bs', header: 'B.S. date', cell: (r) => r.cancelled_date_bs },
  { id: 'ad', header: 'A.D. date', cell: (r) => <Ad value={r.cancelled_date_ad} /> },
  { id: 'no', header: 'Invoice no', isRowHeader: true, cell: (r) => r.invoice_no },
  { id: 'cn', header: 'Credit-note no', cell: (r) => r.credit_note_no },
  { id: 'buyer', header: 'Buyer', cell: (r) => r.buyer_name ?? '—' },
  { id: 'pan', header: 'PAN', cell: (r) => r.buyer_pan ?? '—' },
  { id: 'total', header: 'Total', align: 'end', cell: (r) => npr(r.total) },
  { id: 'reason', header: 'Reason', cell: (r) => humanize(r.reason_code) },
];
const creditCols: ColumnDef<CreditNoteRegisterRow>[] = [
  { id: 'sn', header: 'SN', align: 'end', cell: (r) => String(r.sn) },
  { id: 'bs', header: 'B.S. date', cell: (r) => r.credit_note_date_bs },
  { id: 'ad', header: 'A.D. date', cell: (r) => <Ad value={r.credit_note_date_ad} /> },
  { id: 'cn', header: 'Credit-note no', isRowHeader: true, cell: (r) => r.credit_note_no },
  { id: 'kind', header: 'Kind', cell: (r) => (r.kind === 'cancellation' ? 'Cancellation' : 'Partial') },
  { id: 'no', header: 'Invoice no', cell: (r) => r.invoice_no },
  { id: 'buyer', header: 'Buyer', cell: (r) => r.buyer_name ?? '—' },
  { id: 'pan', header: 'PAN', cell: (r) => r.buyer_pan ?? '—' },
  { id: 'reason', header: 'Reason', cell: (r) => humanize(r.reason_code) },
  { id: 'exempt', header: 'Exempt', align: 'end', cell: (r) => npr(r.exempt) },
  { id: 'taxable', header: 'Taxable', align: 'end', cell: (r) => npr(r.taxable) },
  { id: 'vat', header: 'VAT', align: 'end', cell: (r) => npr(r.vat) },
  { id: 'other', header: 'Other tax', align: 'end', cell: (r) => npr(r.other_tax) },
  { id: 'net', header: 'Net', align: 'end', cell: (r) => npr(r.net) },
];

export function RegistersView({ sales: salesRows, cancelled, creditNotes, permissions }: { sales: readonly SalesRegisterRow[]; cancelled: readonly CancelledInvoiceRow[]; creditNotes: readonly CreditNoteRegisterRow[]; permissions: readonly string[] }) {
  const [tab, setTab] = useState<Tab>('sales');
  const f = useUrlFilters(['fiscal_year_bs', 'date_range']);
  const range = Array.isArray(f.value['date_range']) ? (f.value['date_range'] as string[]) : [];
  const fy = typeof f.value['fiscal_year_bs'] === 'string' ? (f.value['fiscal_year_bs'] as string) : undefined;
  const exportFilters = { ...(fy ? { fiscal_year_bs: fy } : {}), ...(range[0] && range[1] ? { from: range[0], to: range[1] } : {}) };
  const active = TABS.find((t) => t.id === tab)!;
  return (
    <section aria-label="Registers">
      <PageHeader
        title="Registers"
        helpKey="billing.registers"
        actions={hasPerm(permissions, 'billing.data.export') ? <ExportButtons key={active.kind} kind={active.kind} formats={['xlsx', 'xml', 'pdf']} filters={exportFilters} /> : null}
      />
      <FilterBar
        filters={[{ id: 'fiscal_year_bs', label: 'Fiscal year (B.S.), e.g. 2083/84', kind: 'text', maxLength: 9 }, { id: 'date_range', label: 'Date range', kind: 'date_range' }]}
        value={f.value}
        onChange={f.onChange}
        onReset={f.onReset}
      />
      <Tabs items={TABS.map((t) => ({ id: t.id, label: t.label }))} selectedId={tab} onChange={(id) => setTab(id as Tab)} aria-label="Registers">
        {tab === 'sales' ? <DataTable caption="Sales register" columns={sales} rows={salesRows} getRowId={(r) => String(r.sn) + r.invoice_no} emptyState={EMPTY} /> : null}
        {tab === 'cancelled' ? <DataTable caption="Cancelled invoices register" columns={cancelledCols} rows={cancelled} getRowId={(r) => String(r.sn) + r.invoice_no} emptyState={EMPTY} /> : null}
        {tab === 'credit_notes' ? <DataTable caption="Credit notes register" columns={creditCols} rows={creditNotes} getRowId={(r) => String(r.sn) + r.credit_note_no} emptyState={EMPTY} /> : null}
      </Tabs>
    </section>
  );
}
