// Fiscal invoice layout (04-UI-UX §8.3). Used by the detail screen and the print template, so what is on screen is what is printed.
// Real text only (screen readers, copy); data-driven rows so statutory fields can be added without a layout change (04 L10, B6).
import { DataUriImage } from '@lims/ui/components/DataUriImage';
import type { InvoicePrintDocument } from '../server/types';
import { Ad, BsAd, amountInWords, npr } from './format';

export function InvoiceDocument({ document: d }: { document: InvoicePrintDocument }) {
  const title = d.invoice_kind === 'abbreviated' ? 'ABBREVIATED TAX INVOICE' : 'TAX INVOICE';
  const b = d.branding;
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
    <article className="lims-invoice-doc" aria-label={`${title} ${d.invoice_no}`}>
      {b ? (
        <header className="lims-invoice-branding">
          {b.images?.filter((i) => i.kind === 'logo').map((i, n) => <DataUriImage key={n} src={i.data_uri} alt="Logo" />)}
          <p><strong>{b.legal_name}</strong></p>
          {b.address_lines?.map((l, n) => <p key={n}>{l}</p>)}
          {b.phones?.length ? <p>{b.phones.join(', ')}</p> : null}
        </header>
      ) : null}
      <h2>{title}</h2>
      {showCopy ? <p className="lims-copy-mark"><strong>{d.copy_mark}</strong></p> : null}
      {d.cancelled_banner ? <p className="lims-cancelled-banner" style={{ border: '2px solid var(--lims-danger, #b00020)', padding: 8 }}><strong>{d.cancelled_banner}</strong></p> : null}
      <dl className="lims-invoice-meta">
        <dt>Seller PAN</dt><dd>{d.seller.pan ?? '—'}</dd>
        <dt>Invoice no</dt><dd>{d.invoice_no}</dd>
        <dt>Invoice date</dt>
        <dd>{d.dates ? <>{d.dates.bs} B.S. / {d.dates.ad}</> : <BsAd bs={d.invoice_date_bs} utc={d.issued_at} withTime />}</dd>
        <dt>Fiscal year</dt><dd>{d.fiscal_year_bs}</dd>
        <dt>Buyer</dt><dd>{d.buyer.name ?? '—'}</dd>
        {d.buyer.pan ? <><dt>Buyer PAN</dt><dd>{d.buyer.pan}</dd></> : null}
        {d.registration_no ? <><dt>Registration no</dt><dd>{d.registration_no}</dd></> : null}
      </dl>
      <p>Referred by: {d.referrer_id ? (d.referrer_name ?? 'Referrer on file') : 'Self'}</p>
      <table className="lims-invoice-lines">
        <caption>Invoice lines</caption>
        <thead>
          <tr><th scope="col">S.N.</th><th scope="col">Code</th><th scope="col">Description</th><th scope="col">Rate</th><th scope="col">Discount</th><th scope="col">Amount</th></tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.line_no}</td><td>{l.code ?? ''}</td><td>{l.name}</td>
              <td>{npr(l.unit_price)}</td><td>{npr(l.discount)}</td><td>{npr(l.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="lims-invoice-totals">
        {totals.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p>Amount in words: {amountInWords(d.totals.net.amount_paisa)}</p>
      {d.payment_block ? (
        <section aria-label="Payment summary">
          <h3>Payment summary (not part of the invoice)</h3>
          <dl>
            <dt>Paid</dt><dd>{npr(d.payment_block.paid)}</dd>
            <dt>Balance due</dt><dd>{npr(d.payment_block.balance_due)}</dd>
          </dl>
        </section>
      ) : null}
      {d.printed_by_display && d.printed_at ? <p>Printed by {d.printed_by_display} on <Ad value={d.printed_at} withTime /></p> : null}
      {d.footer_note ? <p>{d.footer_note}</p> : null}
    </article>
  );
}
