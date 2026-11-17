'use client';
// 04-UI-UX §8.3 invoice print template. The pure layout is `InvoicePrintView`; `InvoicePrintFrame` sends it through the kit's PrintFrame
// (hidden iframe + window.print) so the print count is recorded by B3 before anything reaches the printer (Ctrl+P is never overridden).
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import type { InvoicePrintDocument } from '../../server/types';
import { InvoiceDocument } from '../InvoiceDocument';

export function InvoicePrintView({ document }: { document: InvoicePrintDocument }) {
  return <InvoiceDocument document={document} />;
}

export function InvoicePrintFrame({ document, isOpen, onDone }: { document: InvoicePrintDocument; isOpen: boolean; onDone: () => void }) {
  return (
    <PrintFrame title={`Invoice ${document.invoice_no}`} isOpen={isOpen} onDone={onDone}>
      <InvoicePrintView document={document} />
    </PrintFrame>
  );
}
