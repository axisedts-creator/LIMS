'use client';
// Fiscal invoice layout (04-UI-UX §8.3). Used by the detail screen and the print template, so what is on screen is what is printed.
// Real text only (screen readers, copy); data-driven rows so statutory fields can be added without a layout change (04 L10, B6).
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DataUriImage } from '@lims/ui/components/DataUriImage';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { BarcodeSymbol } from '@lims/ui/components/BarcodeSymbol';
import type { InvoicePrintDocument } from '../server/types';
import { Ad, BsAd, amountInWords, npr } from './format';
import './billing.css';

type Line = InvoicePrintDocument['lines'][number];
// T0D-UIX-4 (LD-442): invoice lines are a kit DataTable (money end aligned with tabular figures), the fields a kit DescriptionList.
const LINE_COLUMNS: ColumnDef<Line>[] = [
  { id: 'sn', header: 'S.N.', numeric: true, cell: (l) => l.line_no },
  { id: 'code', header: 'Code', cell: (l) => l.code ?? '' },
  { id: 'name', header: 'Description', isRowHeader: true, cell: (l) => l.name },
  { id: 'rate', header: 'Rate', numeric: true, cell: (l) => npr(l.unit_price) },
  { id: 'discount', header: 'Discount', numeric: true, cell: (l) => npr(l.discount) },
  { id: 'amount', header: 'Amount', numeric: true, cell: (l) => npr(l.net) },
];

/** `plain` (T0D-PRINTCFG-1, LD-316): the plain black and white tax bill: no logo, no phone line, no footer text; lab name, address, seller PAN,
 * bill number and date stay. The server also prints plain_bw this way; the client strips again so a stale document never prints a logo. */
export function InvoiceDocument({ document: d, plain = false }: { document: InvoicePrintDocument; plain?: boolean }) {
  const title = d.invoice_kind === 'abbreviated' ? 'ABBREVIATED TAX INVOICE' : 'TAX INVOICE';
  const b = d.branding && plain ? { ...d.branding, images: [], phones: [] } : d.branding;
  const showCopy = (d.print_no ?? 0) >= 2 && d.copy_mark;
  const totals: [string, string][] = [
    ['Gross', npr(d.totals.gross)],
    ['Discount', npr(d.totals.discount)],
    ['Exempt', npr(d.totals.exempt)],
    ['Taxable', npr(d.totals.taxable)],
    ['VAT 13%', npr(d.totals.vat)],
    ['Other tax', npr(d.totals.other_tax)],
    ['Net', npr(d.totals.net)],
  ];
  return (
    <article className="lims-invoice-doc"{...(plain ? { 'data-plain': 'true' } : {})} aria-label={`${title} ${d.invoice_no}`}>
      {b ? (
        <header className="lims-invoice-branding">
          {b.images?.filter((i) => i.kind === 'logo').map((i, n) => <DataUriImage key={n} src={i.data_uri} alt="Logo" />)}
          <p><strong>{b.legal_name}</strong></p>
          {b.address_lines?.map((l, n) => <p key={n}>{l}</p>)}
          {b.phones?.length ? <p>{b.phones.join(', ')}</p> : null}
        </header>
      ) : null}
      {/* T0D-UIGUARD-1-BILLING (LD-436 R7, LD-439): document headings use the kit card title style with heading semantics, not a raw h2/h3. */}
      <p role="heading" aria-level={2} className="lims-card-title">{title}</p>
      {showCopy ? <p className="lims-copy-mark"><strong>{d.copy_mark}</strong></p> : null}
      {d.cancelled_banner ? <p className="lims-cancelled-banner"><strong>{d.cancelled_banner}</strong></p> : null}
      <DescriptionList
        columns={2}
        items={[
          { term: 'Seller PAN', value: d.seller.pan ?? '—' },
          { term: 'Invoice no', value: d.invoice_no },
          { term: 'Invoice date', value: d.dates ? <>{d.dates.bs} B.S. / {d.dates.ad}</> : <BsAd bs={d.invoice_date_bs} utc={d.issued_at} withTime /> },
          { term: 'Fiscal year', value: d.fiscal_year_bs },
          { term: 'Buyer', value: d.buyer.name ?? '—' },
          ...(d.buyer.pan ? [{ term: 'Buyer PAN', value: d.buyer.pan }] : []),
          ...(d.registration_no ? [{
            term: 'Registration no',
            value: (
              <span className="lims-invoice-reg-cell">
                <span>{d.registration_no}</span>
                {/^[A-Z0-9-]{1,32}$/.test(d.registration_no.trim()) ? (
                  <span className="lims-invoice-barcode" role="img" aria-label={`Barcode ${d.registration_no.trim()}`}>
                    <BarcodeSymbol value={d.registration_no.trim()} heightMm={8} moduleWidthMm={0.25} showText={false} />
                  </span>
                ) : null}
              </span>
            ),
          }] : []),
        ]}
      />
      <p>Referred by: {d.referrer_id ? (d.referrer_name ?? 'Referrer on file') : 'Self'}</p>
      <DataTable caption="Invoice lines" stickyHeader={false} columns={LINE_COLUMNS} rows={d.lines} getRowId={(l) => l.id} emptyState={{ title: 'No lines.' }} />
      <DescriptionList items={totals.map(([term, value]) => ({ term, value }))} />
      <p>Amount in words: {amountInWords(d.totals.net.amount_paisa)}</p>
      {d.payment_block ? (
        <section aria-label="Payment summary">
          <p role="heading" aria-level={3} className="lims-card-title">Payment summary (not part of the invoice)</p>
          <DescriptionList items={[{ term: 'Paid', value: npr(d.payment_block.paid) }, { term: 'Balance due', value: npr(d.payment_block.balance_due) }]} />
        </section>
      ) : null}
      {d.printed_by_display && d.printed_at ? <p>Printed by {d.printed_by_display} on <Ad value={d.printed_at} withTime /></p> : null}
      {d.footer_note && !plain ? <p>{d.footer_note}</p> : null}
    </article>
  );
}
