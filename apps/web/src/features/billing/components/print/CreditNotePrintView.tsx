'use client';
// 04-UI-UX §8.3 credit note: "CREDIT NOTE", CN no, date (B.S. + A.D.), original invoice no/date, reason, lines, totals.
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DataUriImage } from '@lims/ui/components/DataUriImage';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import type { CreditNotePrintDocument } from '../../server/types';
import { BsAd, humanize, npr } from '../format';

type Line = CreditNotePrintDocument['lines'][number];
// T0D-UIX-4 (LD-442): credited lines are a kit DataTable, the fields and totals kit DescriptionLists.
const LINE_COLUMNS: ColumnDef<Line>[] = [
  { id: 'sn', header: 'S.N.', numeric: true, cell: (l) => l.line_no },
  { id: 'name', header: 'Description', isRowHeader: true, cell: (l) => l.name },
  { id: 'amount', header: 'Amount', numeric: true, cell: (l) => npr(l.net) },
];

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
      <DescriptionList
        columns={2}
        items={[
          { term: 'Credit note no', value: d.credit_note_no },
          { term: 'Date', value: d.dates ? <>{d.dates.bs} B.S. / {d.dates.ad}</> : <BsAd bs={d.credit_note_date_bs} utc={d.issued_at} withTime /> },
          { term: 'Original invoice', value: <>{d.invoice_no}{d.invoice_date_bs ? <> — <BsAd bs={d.invoice_date_bs} {...(d.invoice_issued_at ? { utc: d.invoice_issued_at } : {})} /></> : null}</> },
          { term: 'Reason', value: `${humanize(d.reason_code)}${d.reason_text ? ` — ${d.reason_text}` : ''}` },
        ]}
      />
      <DataTable caption="Credited lines" stickyHeader={false} columns={LINE_COLUMNS} rows={d.lines} getRowId={(l) => l.id} emptyState={{ title: 'No lines.' }} />
      <DescriptionList items={totals.map(([term, value]) => ({ term, value }))} />
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
