'use client';
// 04-UI-UX §8.3 invoice print template. The pure layout is `InvoicePrintView`; `InvoicePrintFrame` sends it through the kit's PrintFrame
// (hidden iframe + window.print) so the print count is recorded by B3 before anything reaches the printer (Ctrl+P is never overridden).
// T0D-PRINTCFG-1 (LD-316): `plain` prints the plain black and white bill.
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import type { InvoicePrintDocument } from '../../server/types';
import { InvoiceDocument } from '../InvoiceDocument';
// T0D-OFFLINE-3 (LD-322): an offline bill prints its provisional number (DocNumber resolution) with the watermark until the final number is mapped
import { IssuedOfflineWatermark, useDocNumbers } from '@/core/offline/ui/OfflineParts';

export function InvoicePrintView({ document, plain = false }: { document: InvoicePrintDocument; plain?: boolean }) {
  const [invoiceNo = document.invoice_no] = useDocNumbers([document.invoice_no]);
  return <><IssuedOfflineWatermark numbers={[invoiceNo]} /><InvoiceDocument plain={plain} document={invoiceNo === document.invoice_no ? document : { ...document, invoice_no: invoiceNo }} /></>;
}

export function InvoicePrintFrame({ document, isOpen, onDone, plain = false }: { document: InvoicePrintDocument; isOpen: boolean; onDone: () => void; plain?: boolean }) {
  return (
    <PrintFrame title={`Invoice ${document.invoice_no}`} isOpen={isOpen} onDone={onDone}>
      <InvoicePrintView document={document} plain={plain} />
    </PrintFrame>
  );
}
