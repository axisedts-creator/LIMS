// DTO shapes for the payment review screens (02-TRD §4: PaymentIntentSummary / PaymentIntentDetail / RefundDto / coded sets).
// Read defensively: only the fields below are ever rendered; anything else the API sends is ignored.
export interface PaymentMoney { amount_paisa: number; currency: string }

export interface PaymentIntentSummary {
  id: string; order_id: string; centre_id: string; gateway: string; environment?: string; status: string; amount: PaymentMoney;
  hold_reason?: string; failure_reason?: string; created_at: string; expires_at?: string; settled_at?: string; last_checked_at?: string; version: number;
}

export interface PaymentTransition { from_status?: string; to_status: string; cause?: string; reason_code?: string; actor_type: string; at: string }
export interface PaymentGatewayCheck { operation: string; outcome: string; gateway_status_raw?: string; http_status?: number; at: string }
export interface PaymentCallback { kind: string; outcome_code: string; signature_valid?: boolean; at: string }
export interface PaymentRefund { id: string; status: string; amount: PaymentMoney; reason_code?: string; requested_at: string }

export interface PaymentIntentDetail extends PaymentIntentSummary {
  gateway_txn_ref?: string; gateway_secondary_ref?: string; last_gateway_status_raw?: string; verified_amount?: PaymentMoney; verification_method?: string;
  refunded_amount?: PaymentMoney; ledger_entry_id?: string; created_by_actor_type?: string;
  transitions?: PaymentTransition[]; gateway_checks?: PaymentGatewayCheck[]; callbacks?: PaymentCallback[]; refunds?: PaymentRefund[];
}

export interface CodedValue { code: string; display: string; requires_text?: boolean; is_active?: boolean }
export interface IntentCodes { resolution_reasons: readonly CodedValue[]; cancel_reasons: readonly CodedValue[] }
export interface PaymentCentre { id: string; name: string }
