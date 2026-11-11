// PG-T12: the DTO field allowlists of 02-TRD §5.1 (copied verbatim; shared by the contract, mapper and HTTP tests).
export const SUMMARY = ['id', 'order_id', 'centre_id', 'gateway', 'environment', 'status', 'amount', 'hold_reason', 'failure_reason', 'created_at', 'expires_at', 'settled_at', 'last_checked_at', 'version'];
export const DETAIL_EXTRA = ['gateway_txn_ref', 'gateway_secondary_ref', 'last_gateway_status_raw', 'verified_amount', 'verification_method', 'refunded_amount', 'ledger_entry_id',
  'created_by_actor_type', 'transitions', 'gateway_checks', 'callbacks', 'refunds'];
export const CODE_ITEM = ['code', 'display', 'requires_text', 'is_active'];
/** never in any response body (TRD §5.1 DTO note, 07-SECURITY logging) */
export const SENTINELS = ['RETURN-URL-SENTINEL', 'CANCEL-URL-SENTINEL', 'PAYMENT-URL-SENTINEL', 'TOKEN-HASH-SENTINEL', 'MERCHANT-SENTINEL', 'FINGERPRINT-SENTINEL', 'IDEM-SENTINEL', 'RAW-PAYLOAD-SENTINEL', 'SECRET-SENTINEL'];
/** a JSON body must contain no null anywhere (02-CV §4) */
export const hasNull = (v: unknown): boolean => v === null || (typeof v === 'object' && v !== undefined && Object.values(v as object).some(hasNull));
