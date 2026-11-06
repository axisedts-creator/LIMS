// contracts/ports/PaymentProviderPort.ts
import type { RequestContext, Uuidv7, IsoUtc, Money, Code } from './common';
export const PAYMENT_PROVIDER_PORT_VERSION = 1 as const;

export type Gateway = 'esewa' | 'khalti' | 'fonepay';
export type IntentAction =
  | { kind: 'form_post'; url: string; fields: Readonly<Record<string, string>>; launchUrl?: string }   // eSewa ePay v2 form POST (04 P3); launchUrl added by 08 (CR-C15-001)
  | { kind: 'redirect'; url: string }                                               // Khalti payment_url (04 P4)
  | { kind: 'qr'; qrPayload: string };                                              // Fonepay dynamic QR — BLOCKED B8
export type IntentStatus = 'created' | 'initiated' | 'pending' | 'settled' | 'failed' | 'expired' | 'held_for_review'
  | 'refunded' | 'partially_refunded';

export interface PaymentProviderPortV1 {
  /** Amount is computed server-side from BillingPort.getOrderBalance — the caller never supplies it (REQ-SEC-046).
   *  @throws payments.intent_open_exists (one open intent per order — 04 P6), payments.nothing_due, payments.gateway_not_available,
   *          payments.amount_not_supported, payments.return_url_not_allowed (added by 08) */
  createIntent(ctx: RequestContext, input: { orderId: Uuidv7; gateway: Gateway; idempotencyKey: string; returnUrl: string; cancelUrl: string }):
    Promise<{ intentId: Uuidv7; gateway: Gateway; amount: Money; action: IntentAction; expiresAt?: IsoUtc; replayed: boolean }>;
  /** Server-to-server verification (04 P7). Settles only on eSewa COMPLETE / Khalti Completed with exact amount match;
   *  on settle calls BillingPort.recordGatewayPayment in ctx.tx and emits payments.intent.settled.v1.
   *  Khalti Pending/Refunded/Partially Refunded/unknown and eSewa AMBIGUOUS(AMBIGIOUS)/FULL_REFUND/PARTIAL_REFUND/unknown → held_for_review (04 P3/P4).
   *  eSewa PENDING/NOT_FOUND and Khalti Initiated are non-terminal (keep polling) until `expires_at` + grace; after it → held_for_review
   *  (PENDING, Initiated) or expired (NOT_FOUND) (08 A19 D-114, pending 04 P4 amendment F-08; contract case 5). */
  verify(ctx: RequestContext, input: { intentId: Uuidv7 }): Promise<{ intentId: Uuidv7; status: IntentStatus; gatewayStatusRaw?: string; verifiedAmount?: Money }>;
  /** Privileged (REQ-SEC-055). @throws payments.refund_exceeds_captured, payments.refund_requires_approval, payments.gateway_not_available */
  refund(ctx: RequestContext, input: { intentId: Uuidv7; amount: Money; reasonCode: Code; idempotencyKey: string; approvalId: Uuidv7 }):
    Promise<{ refundId: Uuidv7; status: 'requested' | 'completed' | 'failed' | 'held_for_review'; replayed: boolean }>;
  // ---- added by 08 (CR-C15-001)
  /** Read-only, no gateway call. `action` only while initiated/pending. */
  getIntent(ctx: RequestContext, input: { intentId: Uuidv7 }): Promise<{ intentId: Uuidv7; orderId: Uuidv7; gateway: Gateway; status: IntentStatus;
    amount: Money; refundedAmount: Money; expiresAt?: IsoUtc; settledAt?: IsoUtc; action?: IntentAction }>;
  /** Verifies first; settles instead if paid. @throws payments.intent_invalid_transition */
  cancelIntent(ctx: RequestContext, input: { intentId: Uuidv7; reasonCode: Code }): Promise<{ intentId: Uuidv7; status: IntentStatus }>;
}
export type PaymentProviderPort = PaymentProviderPortV1;
