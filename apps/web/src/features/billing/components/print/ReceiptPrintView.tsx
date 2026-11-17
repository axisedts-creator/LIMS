'use client';
// 04-UI-UX §8.3 receipt (non-fiscal): "PAYMENT RECEIPT", receipt no, date, order registration no, invoice no(s), method, amount, balance after.
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import type { ReceiptDocument } from '../../server/types';
import { Ad, humanize, npr } from '../format';

export function ReceiptPrintView({ receipt: r }: { receipt: ReceiptDocument }) {
  return (
    <article className="lims-receipt-doc" aria-label={`Payment receipt ${r.receipt_no}`}>
      {r.branding?.legal_name ? <header><p><strong>{r.branding.legal_name}</strong></p></header> : null}
      <h2>PAYMENT RECEIPT</h2>
      <dl>
        <dt>Receipt no</dt><dd>{r.receipt_no}</dd>
        <dt>Date</dt><dd>{r.dates ? r.dates.ad : <Ad value={r.issued_at} withTime />}</dd>
        {r.registration_no ? <><dt>Registration no</dt><dd>{r.registration_no}</dd></> : null}
        <dt>Invoice no</dt><dd>{r.invoice_nos.join(', ') || '—'}</dd>
        <dt>Method</dt><dd>{humanize(r.method_code)}</dd>
        <dt>Amount</dt><dd>{npr(r.amount)}</dd>
        {r.balance_after ? <><dt>Balance after</dt><dd>{npr(r.balance_after)}</dd></> : null}
      </dl>
    </article>
  );
}

export function ReceiptPrintFrame({ receipt, isOpen, onDone }: { receipt: ReceiptDocument; isOpen: boolean; onDone: () => void }) {
  return (
    <PrintFrame title={`Receipt ${receipt.receipt_no}`} isOpen={isOpen} onDone={onDone}>
      <ReceiptPrintView receipt={receipt} />
    </PrintFrame>
  );
}
