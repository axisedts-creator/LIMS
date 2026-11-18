'use client';
// T0D-UIKIT-1, LD-353 template 3 (SCAN): the scan input (at most 28rem, light focus ring, kit.css), the last scan result card, the queue below.
// Scanning is BarcodeInput unchanged (charset, duplicate guard, no logging of the value).
import type { ReactNode } from 'react';
import { BarcodeInput, type BarcodeInputProps } from '../BarcodeInput/BarcodeInput';

export type ScanPanelProps = BarcodeInputProps & {
  /** The last scan result card. */
  result?: ReactNode;
  /** The queue (usually a DataTable). */
  children?: ReactNode;
};

export function ScanPanel({ result, children, 'data-testid': testId, ...input }: ScanPanelProps) {
  return (
    <div className="lims-scan-panel" {...(testId ? { 'data-testid': testId } : {})}>
      <div className="lims-scan-input">
        <BarcodeInput {...input} />
      </div>
      {result ? <div className="lims-scan-result" role="status">{result}</div> : null}
      {children ? <div className="lims-scan-queue">{children}</div> : null}
    </div>
  );
}
