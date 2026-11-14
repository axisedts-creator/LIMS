// contracts/ports/BillingPort.ts
import type { RequestContext, Uuidv7, IsoUtc, Money, Code } from './common';
export const BILLING_PORT_VERSION = 1 as const;

export type ReleaseBasis = 'paid_in_full' | 'zero_balance' | 'credit_party' | 'override' | 'policy_not_enforced'
  | 'due_outstanding' | 'no_invoice';
export interface ReleaseEligibility {
  readonly orderId: Uuidv7; readonly eligible: boolean; readonly basis: ReleaseBasis;
  readonly balanceDue: Money; readonly overrideId?: Uuidv7; readonly evaluatedAt: IsoUtc;
}
export interface OrderBalance {
  readonly orderId: Uuidv7; readonly invoiced: Money; readonly paid: Money; readonly credited: Money;
  readonly balanceDue: Money; readonly balanceVersion: number; readonly asOf: IsoUtc;
}
export interface GatewayPaymentInput {
  readonly intentId: Uuidv7; readonly orderId: Uuidv7; readonly invoiceId?: Uuidv7;
  readonly gateway: 'esewa' | 'khalti' | 'fonepay'; readonly gatewayTxnRef: string;
  readonly amount: Money; readonly verifiedAt: IsoUtc;
  readonly allowExceedsDue?: boolean;          // added by 08: true → record full amount + finance_review_items 'gateway_payment_exceeds_due'
}
// ---- added by 08 (CR-C15-002)
export interface GatewayRefundInput {
  readonly refundId: Uuidv7; readonly intentId: Uuidv7; readonly orderId: Uuidv7;
  readonly gateway: 'esewa' | 'khalti' | 'fonepay'; readonly gatewayTxnRef: string;
  readonly amount: Money;                      // positive; stored negative, entry_kind 'refund', capture_kind 'gateway'
  readonly reasonCode: Code; readonly approvedByMembershipId: Uuidv7; readonly refundedAt: IsoUtc }

export interface BillingPortV1 {
  /** Hold-till-paid gate (00 D1; 01 §1.4): tenant setting releaseRequiresPayment; credit-party orders eligible; authorised override recorded by C6 via HTTP to billing. */
  getReleaseEligibility(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<ReleaseEligibility>;
  /** Append-only ledger write (04 P1; REQ-SEC-057). Idempotent on (gateway, gatewayTxnRef) (04 P6).
   *  @throws billing.amount_mismatch (amount ≠ intent amount recorded by C15), billing.payment_exceeds_due */
  recordGatewayPayment(ctx: RequestContext, input: GatewayPaymentInput): Promise<{ ledgerEntryId: Uuidv7; duplicate: boolean; balance: OrderBalance }>;
  getOrderBalance(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<OrderBalance>;
  // ---- added by 08
  /** Idempotent on refundId (idempotency_key 'gw_refund:'+refundId). @throws billing.ledger_reversal_invalid */
  recordGatewayRefund(ctx: RequestContext, input: GatewayRefundInput): Promise<{ ledgerEntryId: Uuidv7; duplicate: boolean; balance: OrderBalance }>;
}
export type BillingPort = BillingPortV1;
