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
export interface IntentCodes { resolution_reasons: readonly CodedValue[]; cancel_reasons: readonly CodedValue[]; refund_reasons?: readonly CodedValue[] }
export interface PaymentCentre { id: string; name: string }

// PG-T19 (02-TRD §4): refunds, reconciliation, static-QR worksheet, merchant settings. Only the fields below are ever rendered.
export interface PersonRef { membership_id: string; display_name: string }
export interface RefundDto {
  id: string; intent_id: string; order_id?: string; gateway: string; mode: string; status: string; amount: PaymentMoney; reason_code?: string;
  requested_by?: PersonRef; requested_at: string; approved_by?: PersonRef; approved_at?: string; held_reason?: string; version: number;
}
export interface RefundCodes { refund_reject_reasons: readonly CodedValue[]; refund_fail_reasons: readonly CodedValue[]; refund_hold_reasons: readonly CodedValue[] }

export interface ReconciliationRunDto {
  id: string; business_date: string; trigger: string; status: string; started_at?: string; finished_at?: string;
  counts?: { checked?: number; ok?: number; findings?: number; critical?: number }; version?: number;
}
export interface FindingDto {
  id: string; kind: string; severity: string; intent_id?: string; our_status?: string; gateway_status_raw?: string; our_amount?: PaymentMoney; gateway_amount?: PaymentMoney;
  auto_action?: string; status?: string; created_at: string; version: number;
}
export interface ReconStats { lastSuccessfulRunAt?: string; openCritical: number; underReview: number }
export interface ReconCodes { finding_kinds: readonly CodedValue[]; finding_resolutions: readonly CodedValue[] }

export interface StaticQrReconDto {
  id: string; business_date: string; centre_id?: string; system_entries?: number; system_total: PaymentMoney; statement_total: PaymentMoney; difference: PaymentMoney;
  statement_reference?: string; status: string; reconciled_by?: PersonRef; created_at: string;
}

export interface MerchantAccountDto {
  gateway: string; environment: string; is_enabled: boolean; esewa_product_code?: string; khalti_website_url?: string; api_refunds_enabled?: boolean; version?: number;
  secret?: { is_set: boolean; set_at?: string; fingerprint?: string };
}
export interface PaymentSettingsDto { refund_two_person_threshold: PaymentMoney; purchase_order_label: string; reconciliation_enabled: boolean; version: number }
