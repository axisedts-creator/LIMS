'use client';
// S6-P print view of a purchase order (04-UI-UX §3 S6): tenant display name, branch, PO no., dates, supplier block, lines, totals.
// A draft is marked "DRAFT — NOT APPROVED" (a danger Banner: tone + icon + word). No QR code and no signature block [CONV].
// The browser prints the page itself (window.print); "Print" is the ONE primary of the page. LD-140 (2026-11-13): kit components only.
// Open point: the spec also asks for the approver's display name and a diagonal watermark; PoPrintView carries no approver field (CR candidate).
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import type { PoPrintLine, PoPrintView } from '../server/types';
import { EXEMPT_LABEL } from './PoShared';
import { isoDate } from './shared';

const rupees = (paisa: number) => <MoneyText value={{ amountPaisa: paisa, currency: 'NPR' }} />;

export function PoPrint({ doc }: { doc: PoPrintView }) {
  const columns: ColumnDef<PoPrintLine>[] = [
    { id: 'no', header: '#', isRowHeader: true, cell: (l) => l.line_no },
    { id: 'code', header: 'Item code', cell: (l) => l.item_code },
    { id: 'name', header: 'Item', cell: (l) => l.item_name },
    { id: 'pack', header: 'Pack', cell: (l) => l.pack_label },
    { id: 'qty', header: 'Qty packs', align: 'end', cell: (l) => l.qty_packs },
    { id: 'price', header: 'Unit price', align: 'end', cell: (l) => rupees(l.unit_price_paisa) },
    { id: 'discount', header: 'Discount', align: 'end', cell: (l) => rupees(l.discount_paisa) },
    { id: 'tax', header: 'Tax', cell: (l) => (l.is_exempt ? EXEMPT_LABEL : (l.tax_code ?? '—')) },
    { id: 'total', header: 'Line total', align: 'end', cell: (l) => rupees(l.line_total_paisa) },
  ];
  return (
    <section aria-label={`Purchase order ${doc.po_no}`}>
      <PageHeader title={doc.tenant_display_name} helpKey="inventory.purchase_orders" actions={<Button variant="primary" onPress={() => window.print()}>Print</Button>} />
      <Stack>
        {doc.is_draft ? <Banner tone="danger" title="DRAFT — NOT APPROVED" /> : null}
        <DescriptionList
          columns={2}
          items={[
            { term: 'Branch', value: doc.branch_name },
            { term: 'Purchase order', value: doc.po_no },
            { term: 'Created', value: isoDate(doc.created_at) },
            { term: 'Expected on', value: isoDate(doc.expected_on) },
            { term: 'Supplier', value: `${doc.supplier.supplier_code} — ${doc.supplier.name}` },
            ...(doc.supplier.pan_text ? [{ term: 'PAN / VAT no.', value: doc.supplier.pan_text }] : []),
            ...(doc.supplier.address_text ? [{ term: 'Address', value: doc.supplier.address_text }] : []),
          ]}
        />
        <DataTable caption="Order lines" columns={columns} rows={doc.lines} getRowId={(l) => String(l.line_no)} density="compact" emptyState={{ title: 'No lines.' }} />
        <DescriptionList
          columns={3}
          items={[
            { term: 'Subtotal', value: rupees(doc.subtotal_paisa) },
            { term: 'Discount', value: rupees(doc.discount_paisa) },
            { term: 'Net', value: rupees(doc.net_paisa) },
            { term: 'VAT', value: rupees(doc.vat_paisa) },
            { term: 'Total', value: rupees(doc.total_paisa) },
          ]}
        />
      </Stack>
    </section>
  );
}
