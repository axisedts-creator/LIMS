'use client';
// 04-UI-UX §8.3 credit note: "CREDIT NOTE", CN no, date (B.S. + A.D.), original invoice no/date, reason, lines, totals.
import { DataUriImage } from '@lims/ui/components/DataUriImage';
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import type { CreditNotePrintDocument } from '../../server/types';
import { BsAd, humanize, npr } from '../format';

export function CreditNotePrintView({ document: d }: { document: CreditNotePrintDocument }) {
  const totals: [string, string][] = [
    ['Exempt', npr(d.totals.exempt)], ['Taxable', npr(d.totals.taxable)], ['VAT 13%', npr(d.totals.vat)], ['Other tax', npr(d.totals.other_tax)], ['Net', npr(d.totals.net)],
  ];
  return (
    <article className="lims-invoice-doc" aria-label={`Credit note ${d.credit_note_no}`}>
      {d.branding ? (
        <header className="lims-invoice-branding">
          {d.branding.images?.filter((i) => i.kind === 'logo').map((i, n) => <DataUriImage key={n} src={i.data_uri} alt="Logo" />)}
          <p><strong>{d.branding.legal_name}</strong></p>
          {d.branding.address_lines?.map((l, n) => <p key={n}>{l}</p>)}
        </header>
      ) : null}
      <h2>CREDIT NOTE</h2>
      {(d.print_no ?? 0) >= 2 && d.copy_mark ? <p><strong>{d.copy_mark}</strong></p> : null}
      <dl>
        <dt>Credit note no</dt><dd>{d.credit_note_no}</dd>
        <dt>Date</dt><dd>{d.dates ? <>{d.dates.bs} B.S. / {d.dates.ad}</> : <BsAd bs={d.credit_note_date_bs} utc={d.issued_at} withTime />}</dd>
        <dt>Original invoice</dt>
        <dd>{d.invoice_no}{d.invoice_date_bs ? <> — <BsAd bs={d.invoice_date_bs} {...(d.invoice_issued_at ? { utc: d.invoice_issued_at } : {})} /></> : null}</dd>
        <dt>Reason</dt><dd>{humanize(d.reason_code)}{d.reason_text ? ` — ${d.reason_text}` : ''}</dd>
      </dl>
      <table className="lims-invoice-lines">
        <caption>Credited lines</caption>
        <thead><tr><th scope="col">S.N.</th><th scope="col">Description</th><th scope="col">Amount</th></tr></thead>
        <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.line_no}</td><td>{l.name}</td><td>{npr(l.net)}</td></tr>)}</tbody>
      </table>
      <dl className="lims-invoice-totals">{totals.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </article>
  );
}

export function CreditNotePrintFrame({ document, isOpen, onDone }: { document: CreditNotePrintDocument; isOpen: boolean; onDone: () => void }) {
  return (
    <PrintFrame title={`Credit note ${document.credit_note_no}`} isOpen={isOpen} onDone={onDone}>
      <CreditNotePrintView document={document} />
    </PrintFrame>
  );
}
