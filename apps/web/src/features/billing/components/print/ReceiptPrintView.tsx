'use client';
// 04-UI-UX §8.3 receipt (non-fiscal): "PAYMENT RECEIPT", receipt no, date, order registration no, invoice no(s), method, amount, balance after.
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { BarcodeSymbol } from '@lims/ui/components/BarcodeSymbol';
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import type { ReceiptDocument } from '../../server/types';
import { Ad, humanize, npr } from '../format';
// T0D-OFFLINE-3 (LD-322): an offline receipt prints its provisional number with the watermark; a reprint after sync shows the final number
import { DocNumber, IssuedOfflineWatermark } from '@/core/offline/ui/OfflineParts';

export function ReceiptPrintView({ receipt: r }: { receipt: ReceiptDocument }) {
  return (
    <article className="lims-receipt-doc" aria-label={`Payment receipt ${r.receipt_no}`}>
      {r.branding?.legal_name ? <header><p><strong>{r.branding.legal_name}</strong></p></header> : null}
      {/* T0D-UIGUARD-1-FRONTDESK (LD-436 R7): print heading as p role=heading, same as the T0D-UIGUARD-1-BILLING print documents. */}
      <p role="heading" aria-level={2} className="lims-card-title">PAYMENT RECEIPT</p>
      <IssuedOfflineWatermark numbers={[r.receipt_no, ...r.invoice_nos]} />
      {/* T0D-UIX-4 (LD-442): the receipt fields are a kit DescriptionList */}
      <DescriptionList
        items={[
          { term: 'Receipt no', value: <DocNumber value={r.receipt_no} /> },
          { term: 'Date', value: r.dates ? r.dates.ad : <Ad value={r.issued_at} withTime /> },
          ...(r.registration_no ? [{
            term: 'Registration no',
            value: (
              <span className="lims-invoice-reg-cell">
                <span>{r.registration_no}</span>
                {/^[A-Z0-9-]{1,32}$/.test(r.registration_no.trim()) ? (
                  <span className="lims-invoice-barcode" role="img" aria-label={`Barcode ${r.registration_no.trim()}`}>
                    <BarcodeSymbol value={r.registration_no.trim()} heightMm={8} moduleWidthMm={0.25} showText={false} />
                  </span>
                ) : null}
              </span>
            ),
          }] : []),
          { term: 'Invoice no', value: r.invoice_nos.length ? r.invoice_nos.map((n, i) => <span key={n}>{i ? ', ' : ''}<DocNumber value={n} /></span>) : '—' },
          { term: 'Method', value: humanize(r.method_code) },
          { term: 'Amount', value: npr(r.amount) },
          ...(r.balance_after ? [{ term: 'Balance after', value: npr(r.balance_after) }] : []),
        ]}
      />
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
