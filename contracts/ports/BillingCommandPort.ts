// contracts/ports/BillingCommandPort.ts  (owner C4/billing; consumer allowlist: frontdesk only — CI manifest consumer check)
import type { RequestContext, Uuidv7, IsoUtc, Money, Code, Priority } from './common';
import type { OrderBalance } from './BillingPort';
export const BILLING_COMMAND_PORT_VERSION = 1 as const;

export interface PricedLineInput {
  readonly lineRef: string;                    // stable within one draft (orderable id + priority)
  readonly orderItemId?: Uuidv7;               // absent in quotes before items exist
  readonly orderableId: Uuidv7; readonly orderableKind: 'test' | 'panel';
  readonly code: Code; readonly name: string;  // snapshot for the fiscal line
  readonly departmentId?: Uuidv7;              // single department of all member tests, else absent
  readonly priority: Priority;
  readonly unitPrice: Money; readonly urgentSurcharge?: Money;   // from CatalogPort.priceFor
  readonly tax: { readonly vat: 'exempt' | 'taxable'; readonly otherTaxCode?: Code;      // from CatalogPort.priceFor().tax —
                  readonly vatRateBp?: number; readonly otherTaxRateBp?: number; readonly hsCode?: string };  // rates owned by C3 (08 R18)
  readonly priceListId: Uuidv7; readonly priceListVersion: number;
  readonly priceSource: 'explicit' | 'credit_party' | 'referrer' | 'centre' | 'tenant_default';
}
export interface DiscountInput {
  readonly scope: 'line' | 'bill'; readonly lineRef?: string;
  readonly kind: 'amount' | 'percent'; readonly amountPaisa?: number; readonly percentBp?: number;
}
export interface ComputedLine extends PricedLineInput {
  readonly lineKind: 'orderable' | 'urgent_surcharge';
  readonly gross: Money; readonly discount: Money; readonly exempt: Money; readonly taxable: Money;
  readonly vat: Money; readonly otherTax: Money; readonly otherTaxCode?: Code; readonly net: Money;
}
export interface Totals { readonly gross: Money; readonly discount: Money; readonly exempt: Money; readonly taxable: Money;
                          readonly vat: Money; readonly otherTax: Money; readonly net: Money }
export interface QuoteResult {
  readonly lines: readonly ComputedLine[]; readonly totals: Totals;
  readonly fingerprint: string;                // sha256 hex of canonical JSON {lines (incl. tax rates), discounts, totals}
  readonly baseFingerprint: string;            // the same fingerprint computed for the same lines with discounts: [] (discount-approval binding)
}
export interface IssuedInvoiceRef { readonly invoiceId: Uuidv7; readonly invoiceNo: string; readonly fiscalYearBs: string;
                                    readonly issuedAt: IsoUtc; readonly totals: Totals }

export interface BillingCommandPortV1 {
  /** Pure computation, no writes; uses the rates on each line (no C4 tax table — 08 R18).
   *  @throws catalog.tax_config_missing (line taxable without vatRateBp, or otherTaxCode without otherTaxRateBp) */
  computeQuote(ctx: RequestContext, input: { lines: readonly PricedLineInput[]; discounts: readonly DiscountInput[] }): Promise<QuoteResult>;
  /** Locked account, CatalogPort.getCreditParty({purpose:'billing'}) with allowsCredit = false or isActive = false → credit_party_locked.
   *  @throws billing.credit_party_locked, billing.credit_limit_exceeded */
  assertCreditAllowed(ctx: RequestContext, input: { creditPartyId: Uuidv7; additional: Money }): Promise<void>;
  /** Gapless allocation + invoice + lines + events (issued, balance.changed) in ctx.tx.
   *  Recomputes the quote and rejects if fingerprint differs (common.version_conflict).
   *  billing.counter_busy also carries detail "fiscal_year_rollover" when the FY changed during allocation (08 A13 D-25);
   *  the caller (frontdesk) retries its whole transaction once on billing.counter_busy and on SQLSTATE 40P01.
   *  @throws billing.counter_busy, billing.fiscal_year_closed, billing.numbering_pattern_invalid, catalog.tax_config_missing, common.version_conflict */
  issueOrderInvoice(ctx: RequestContext, input: {
    orderId: Uuidv7; patientId: Uuidv7; branchId: Uuidv7; centreId: Uuidv7; referrerId?: Uuidv7;
    buyer: { name: string; pan?: string; address?: string };
    lines: readonly PricedLineInput[]; discounts: readonly DiscountInput[]; expectedFingerprint: string;
    purpose: 'registration' | 'supplementary';
  }): Promise<IssuedInvoiceRef>;
  /** Upserts billing.credit_accounts from CatalogPort.getCreditParty({purpose:'billing'}) (code, name, PAN, address snapshot)
   *  before inserting charges; runs assertCreditAllowed. @throws billing.credit_party_locked, billing.credit_limit_exceeded, common.version_conflict */
  recordCreditCharges(ctx: RequestContext, input: { orderId: Uuidv7; creditPartyId: Uuidv7; branchId: Uuidv7; centreId: Uuidv7;
    referrerId?: Uuidv7; patientDisplayName: string; lines: readonly PricedLineInput[]; discounts: readonly DiscountInput[];
    expectedFingerprint: string }): Promise<{ chargeIds: readonly Uuidv7[]; totals: Totals }>;
  voidCreditCharges(ctx: RequestContext, input: { orderId: Uuidv7; orderItemIds?: readonly Uuidv7[]; reasonCode: Code }):
    Promise<{ voided: number; alreadyInvoiced: readonly Uuidv7[] }>;
  /** Manual or home-collection payment. Receipt numbers use TenantSettings.numbering.receiptNoPattern.
   *  @throws billing.payment_exceeds_due (manual only), billing.order_not_invoiced, billing.counter_busy (incl. detail "fiscal_year_rollover") */
  recordPayment(ctx: RequestContext, input: { orderId: Uuidv7; invoiceId?: Uuidv7; methodCode: Code; amount: Money;
    reference?: string; captureKind: 'manual' | 'home_collection'; idempotencyKey: string; collectedByMembershipId?: Uuidv7;
    capturedAt?: IsoUtc;
    issueReceiptNo: boolean;                     // false for payments taken in the registration transaction (the invoice is the receipt, PRD D-RECEIPT)
  }): Promise<{ ledgerEntryId: Uuidv7; receiptNo?: string; duplicate: boolean; exceedsDue: boolean; balance: OrderBalance }>;
  /** Records that issued invoice lines must be credited (order cancelled / items removed). No fiscal document is created.
   *  Covers the order's own invoices AND credit charges already on a periodic credit bill (voidCreditCharges.alreadyInvoiced):
   *  for those, one task per periodic invoice with invoice_id = charge.invoice_id, invoice_line_ids = the charges' invoice_line_id,
   *  and required = true. */
  raiseCreditNoteRequirement(ctx: RequestContext, input: { orderId: Uuidv7; orderItemIds?: readonly Uuidv7[];
    cause: 'order_cancelled' | 'item_removed'; reasonCode: Code }): Promise<{ required: boolean; taskIds: readonly Uuidv7[] }>;
  getOrderBillingSummary(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<{
    invoiceIds: readonly Uuidv7[]; hasIssuedInvoice: boolean; creditChargeIds: readonly Uuidv7[]; balance: OrderBalance }>;
}
export type BillingCommandPort = BillingCommandPortV1;
