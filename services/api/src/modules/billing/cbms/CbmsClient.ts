// CbmsClient (02-TRD §9): the only seam to the tax authority's CBMS. Types only. The live client is blocked (B6); no endpoint, field name or auth scheme lives here.
export type CbmsDocumentKind = 'invoice' | 'credit_note' | 'invoice_cancellation';
export type CbmsClientOutcome = 'accepted' | 'rejected_permanent' | 'retryable_error' | 'stub_recorded';
export type CbmsClientMode = 'stub' | 'live';

/** Fiscal fields only (07-SECURITY item 7): no test names, no patient names. Amounts are integer paisa. */
export interface CbmsDocument {
  readonly kind: CbmsDocumentKind;
  readonly documentId: string;
  readonly documentNo: string;
  readonly fiscalYearBs: string;
  readonly issuedAtUtc: string;
  readonly dateBs: string;
  readonly sellerPan?: string;
  readonly buyerName: string;
  readonly buyerPan?: string;
  /** credit_note and invoice_cancellation: the original invoice number */
  readonly refInvoiceNo?: string;
  readonly totals: { readonly gross: number; readonly discount: number; readonly exempt: number; readonly taxable: number; readonly vat: number; readonly otherTax: number; readonly net: number };
}

export interface CbmsSubmitInput {
  readonly tenantId: string;
  readonly document: CbmsDocument;
  /** `<kind>:<id>`: the same document always carries the same key */
  readonly idempotencyKey: string;
}
export interface CbmsSubmitResult {
  readonly outcome: CbmsClientOutcome;
  /** accepted only */
  readonly externalRef?: string;
  /** already stripped of anything secret or personal by the client */
  readonly rawStatusRedacted?: string;
}

export interface CbmsClient {
  readonly mode: CbmsClientMode;
  submit(input: CbmsSubmitInput): Promise<CbmsSubmitResult>;
}
