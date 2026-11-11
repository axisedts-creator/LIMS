// PG-T17 test fixture: in-memory fake of `ctx.tx.query` for payments.merchant_accounts, payments.settings and audit.access_log
// (05-SCHEMA §1 constraints copied by name). The repo has no payments migration yet, so the fake is the integration seam (same approach as
// catalog/__tests__/helpers/*Db.ts). Synthetic data only.
// PG-T09 additions: payments.callbacks (append-only), SELECT <cols|*> FROM app.payments_resolve_callback_token($1) (DEFINER emulation), ctx.db.tx = SAVEPOINT.
// Dialect the writer's SQL must stay inside (anything else throws "fake: unsupported SQL"):
//   SELECT <cols|*> FROM <table> [WHERE c AND c ...] [ORDER BY col [ASC|DESC][, ...]] [LIMIT n] [FOR UPDATE]
//   INSERT INTO <table> (cols) VALUES (exprs) [ON CONFLICT [(cols)] DO NOTHING] [RETURNING cols|*]
//   UPDATE <table> SET col = expr[, ...] WHERE c AND c ... [RETURNING cols|*]
//   cond  := col (=|<>|!=|<|<=|>|>=) expr | col IS [NOT] NULL | col IS [NOT] DISTINCT FROM expr | col = ANY($n)   (no OR, no parentheses, no sub-selects)
//   expr  := $n[::type] | now() | NULL | true | false | integer | 'text' | col | col + integer | col + $n
// Modelled: RLS (rows of other tenants invisible; INSERT with a foreign tenant_id -> 42501), NOT NULL (23502), UNIQUE (23505), CHECK (23514), version/defaults,
// writes private to the transaction until COMMIT (run() with rollback:true discards them), node-pg types (timestamptz -> Date, bytea -> Buffer).
import { randomUUID } from 'node:crypto';
import { access } from '../../../../core/audit/access.js';

export type Row = Record<string, any>;
export const TENANT_A = '01930000-0000-7000-8000-00000000000a';
export const TENANT_B = '01930000-0000-7000-8000-00000000000b';
export const USER = '01930000-0000-7000-8000-0000000000c1';
export const NOW = new Date(Date.UTC(2026, 10, 11, 6, 0, 0));
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const pgError = (code: string, message: string, constraint?: string): Error => Object.assign(new Error(message), { code, constraint });

const TABLES = {
  'payments.merchant_accounts': ['id', 'tenant_id', 'gateway', 'environment', 'is_enabled', 'esewa_product_code', 'khalti_website_url', 'secret_ciphertext', 'secret_nonce',
    'secret_auth_tag', 'secret_kek_id', 'secret_fingerprint', 'secret_set_at', 'secret_set_by', 'api_refunds_enabled', 'last_test_outcome', 'last_test_at', 'version',
    'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  'payments.settings': ['tenant_id', 'refund_two_person_threshold_paisa', 'purchase_order_label', 'reconciliation_enabled', 'version', 'is_active', 'created_at',
    'created_by', 'updated_at', 'updated_by'],
  'audit.access_log': ['id', 'tenant_id', 'centre_id', 'actor_id', 'actor_type', 'membership_id', 'support_session_id', 'action', 'entity_type', 'entity_id', 'purpose_code',
    'outcome', 'detail', 'request_id', 'created_by'],
  // PG-T08: 05-SCHEMA §6 (columns, CHECK names, partial unique indexes and both triggers copied by name).
  'payments.intents': ['id', 'tenant_id', 'order_id', 'branch_id', 'centre_id', 'gateway', 'environment', 'merchant_account_id', 'status', 'amount_paisa', 'currency',
    'idempotency_key', 'request_fingerprint', 'return_url', 'cancel_url', 'callback_token_sha256', 'gateway_txn_ref', 'gateway_secondary_ref', 'gateway_payment_url',
    'expires_at', 'initiated_at', 'pending_at', 'settled_at', 'closed_at', 'last_checked_at', 'check_count', 'consecutive_unknown', 'last_gateway_status_raw',
    'verified_amount_paisa', 'verification_method', 'hold_reason', 'failure_reason', 'resolution_reason_code', 'resolution_note', 'resolved_by', 'resolved_at',
    'ledger_entry_id', 'refunded_paisa', 'created_actor_type', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  'payments.intent_transitions': ['id', 'tenant_id', 'intent_id', 'from_status', 'to_status', 'cause', 'reason_code', 'actor_type', 'created_at', 'created_by'],
  'payments.gateway_calls': ['id', 'tenant_id', 'intent_id', 'refund_id', 'merchant_account_id', 'gateway', 'operation', 'attempt', 'http_status', 'outcome',
    'gateway_status_raw', 'response_redacted', 'duration_ms', 'created_at', 'created_by'],
  // PG-T09: 05-SCHEMA §6 payments.callbacks (append-only; CHECK names copied).
  'payments.callbacks': ['id', 'tenant_id', 'intent_id', 'gateway', 'kind', 'query_redacted', 'signature_valid', 'outcome_code', 'received_at', 'created_at', 'created_by'],
  // PG-T12: coded sets (05-SCHEMA §5-§6; g_cs_reasons is GLOBAL = no tenant_id, readable by every tenant, no RLS) and a minimal refunds shell (PG-T14 owns refunds;
  // the staff intent detail only reads it, so this fake models just enough columns to SELECT).
  'payments.g_cs_reasons': ['id', 'set_name', 'code', 'display', 'requires_text', 'sort_order', 'is_active', 'created_at'],
  'payments.cs_reasons': ['id', 'tenant_id', 'set_name', 'code', 'display', 'requires_text', 'sort_order', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  // PG-T14: the full 05-SCHEMA §6 column list (CHECKs, in-flight unique index, mutable-columns + transition trigger modelled below).
  'payments.refunds': ['id', 'tenant_id', 'intent_id', 'order_id', 'centre_id', 'gateway', 'mode', 'status', 'amount_paisa', 'reason_code', 'reason_text', 'idempotency_key',
    'requested_by_membership_id', 'requested_at', 'approved_by_membership_id', 'approved_at', 'rejected_by_membership_id', 'rejected_at', 'reject_reason_code', 'decision_note',
    'gateway_refund_reference', 'refunded_on', 'confirmed_by_membership_id', 'confirmed_at', 'completed_at', 'ledger_entry_id', 'failure_reason', 'failure_note', 'held_reason',
    'last_checked_at', 'unconfirmed_run_count', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  // PG-T13: 05-SCHEMA §6 reconciliation_runs / reconciliation_findings (CHECK + index names copied) and test.markers (P-44 marker rows, see portHarness faults.ledger.marker).
  'payments.reconciliation_runs': ['id', 'tenant_id', 'business_date', 'trigger', 'status', 'started_at', 'finished_at', 'checked_count', 'ok_count', 'findings_count', 'critical_count',
    'error_code', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  'payments.reconciliation_findings': ['id', 'tenant_id', 'run_id', 'intent_id', 'refund_id', 'kind', 'severity', 'our_status', 'gateway_status_raw', 'our_amount_paisa', 'gateway_amount_paisa',
    'auto_action', 'status', 'resolution_code', 'note', 'resolved_by', 'resolved_at', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  'test.markers': ['id', 'tenant_id', 'label'],
} as const;
const GLOBAL_TABLES: readonly string[] = ['payments.g_cs_reasons'];
type Table = keyof typeof TABLES;
const NOT_NULL: Record<Table, string[]> = {
  'payments.merchant_accounts': ['id', 'tenant_id', 'gateway', 'environment', 'is_enabled', 'api_refunds_enabled', 'version', 'is_active', 'created_by', 'updated_by'],
  'payments.settings': ['tenant_id', 'refund_two_person_threshold_paisa', 'purchase_order_label', 'reconciliation_enabled', 'version', 'is_active', 'created_by', 'updated_by'],
  'audit.access_log': ['id', 'tenant_id', 'actor_id', 'actor_type', 'action', 'entity_type', 'outcome', 'detail', 'request_id', 'created_by'],
  'payments.intents': ['id', 'tenant_id', 'order_id', 'branch_id', 'centre_id', 'gateway', 'environment', 'merchant_account_id', 'status', 'amount_paisa', 'currency',
    'idempotency_key', 'request_fingerprint', 'return_url', 'cancel_url', 'callback_token_sha256', 'check_count', 'consecutive_unknown', 'refunded_paisa',
    'created_actor_type', 'version', 'created_by', 'updated_by'],
  'payments.intent_transitions': ['id', 'tenant_id', 'intent_id', 'to_status', 'cause', 'actor_type', 'created_by'],
  'payments.gateway_calls': ['id', 'tenant_id', 'gateway', 'operation', 'attempt', 'outcome', 'duration_ms', 'created_by'],
  'payments.callbacks': ['id', 'tenant_id', 'intent_id', 'gateway', 'kind', 'outcome_code', 'created_by'],
  'payments.g_cs_reasons': ['id', 'set_name', 'code', 'display'],
  'payments.cs_reasons': ['id', 'tenant_id', 'set_name', 'code', 'display', 'created_by', 'updated_by'],
  'payments.refunds': ['id', 'tenant_id', 'intent_id', 'order_id', 'centre_id', 'gateway', 'mode', 'status', 'amount_paisa', 'reason_code', 'idempotency_key', 'requested_by_membership_id',
    'requested_at', 'unconfirmed_run_count', 'version', 'created_by', 'updated_by'],
  'payments.reconciliation_runs': ['id', 'tenant_id', 'business_date', 'trigger', 'status', 'started_at', 'checked_count', 'ok_count', 'findings_count', 'critical_count', 'version', 'created_by', 'updated_by'],
  'payments.reconciliation_findings': ['id', 'tenant_id', 'run_id', 'kind', 'severity', 'auto_action', 'status', 'version', 'created_by', 'updated_by'],
  'test.markers': ['id', 'tenant_id', 'label'],
};
const DEFAULTS: Record<Table, () => Row> = {
  'payments.merchant_accounts': () => ({ is_enabled: false, api_refunds_enabled: false, version: 1, is_active: true }),
  'payments.settings': () => ({ refund_two_person_threshold_paisa: 0, purchase_order_label: 'Lab payment', reconciliation_enabled: true, version: 1, is_active: true }),
  'audit.access_log': () => ({}),
  'payments.intents': () => ({ status: 'created', currency: 'NPR', check_count: 0, consecutive_unknown: 0, refunded_paisa: 0, version: 1 }),
  'payments.intent_transitions': () => ({}),
  'payments.gateway_calls': () => ({ attempt: 1 }),
  'payments.callbacks': () => ({}),
  'payments.g_cs_reasons': () => ({ requires_text: false, sort_order: 0, is_active: true }),
  'payments.cs_reasons': () => ({ requires_text: false, sort_order: 0, version: 1, is_active: true }),
  'payments.refunds': () => ({ status: 'pending_approval', unconfirmed_run_count: 0, version: 1 }),
  'payments.reconciliation_runs': () => ({ status: 'running', checked_count: 0, ok_count: 0, findings_count: 0, critical_count: 0, version: 1 }),
  'payments.reconciliation_findings': () => ({ auto_action: 'none', status: 'open', version: 1 }),
  'test.markers': () => ({}),
};
const nn = (v: unknown): boolean => v !== null && v !== undefined;

function checks(t: Table, r: Row): string | undefined {            // returns the violated constraint name
  if (t === 'payments.settings') {
    if (!(Number(r.refund_two_person_threshold_paisa) >= 0)) return 'settings__threshold__ck';
    if (!/^[A-Za-z0-9 .,&()-]{1,50}$/.test(String(r.purchase_order_label))) return 'settings__label__ck';
    return undefined;
  }
  if (t === 'payments.intents') {
    const settledFamily = ['settled', 'refunded', 'partially_refunded'].includes(r.status);
    if (!['esewa', 'khalti', 'fonepay'].includes(r.gateway)) return 'intents__gateway__ck';
    if (!['uat', 'production'].includes(r.environment)) return 'intents__env__ck';
    if (!['created', 'initiated', 'pending', 'settled', 'failed', 'expired', 'held_for_review', 'refunded', 'partially_refunded'].includes(r.status)) return 'intents__status__ck';
    if (!(Number(r.amount_paisa) > 0 && r.currency === 'NPR')) return 'intents__amount__ck';
    if (r.gateway === 'khalti' && Number(r.amount_paisa) < 1000) return 'intents__khalti_min__ck';
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(String(r.idempotency_key))) return 'intents__idem__ck';
    if (!/^[0-9a-f]{64}$/.test(String(r.request_fingerprint))) return 'intents__fp__ck';
    if (!(/^https:\/\//.test(r.return_url) && /^https:\/\//.test(r.cancel_url) && r.return_url.length <= 2000 && r.cancel_url.length <= 2000)) return 'intents__urls__ck';
    if (!(Buffer.isBuffer(r.callback_token_sha256) && r.callback_token_sha256.length === 32)) return 'intents__token__ck';
    if (nn(r.gateway_txn_ref) && !(r.gateway_txn_ref.length >= 1 && r.gateway_txn_ref.length <= 100)) return 'intents__refs__ck';
    if (nn(r.gateway_secondary_ref) && r.gateway_secondary_ref.length > 64) return 'intents__refs__ck';
    if (nn(r.gateway_payment_url) && !(/^https:\/\//.test(r.gateway_payment_url) && r.gateway_payment_url.length <= 2000)) return 'intents__refs__ck';
    if (r.status !== 'created' && !nn(r.gateway_txn_ref)) return 'intents__initiated_refs__ck';
    if (r.gateway === 'esewa' && nn(r.gateway_txn_ref) && r.gateway_txn_ref !== r.id) return 'intents__esewa_ref__ck';
    if (nn(r.last_gateway_status_raw) && r.last_gateway_status_raw.length > 64) return 'intents__raw__ck';
    if (nn(r.verification_method) && !['esewa_status_check', 'khalti_lookup'].includes(r.verification_method)) return 'intents__method__ck';
    if (r.status === 'held_for_review' && !nn(r.hold_reason)) return 'intents__hold__ck';
    if (['failed', 'expired'].includes(r.status) && !nn(r.failure_reason)) return 'intents__failure__ck';
    if (settledFamily && !(nn(r.settled_at) && nn(r.ledger_entry_id) && nn(r.verified_amount_paisa) && Number(r.verified_amount_paisa) === Number(r.amount_paisa) && nn(r.verification_method))) return 'intents__settled__ck';
    const rf = Number(r.refunded_paisa), am = Number(r.amount_paisa);
    if (!(rf >= 0 && rf <= am && (r.status !== 'refunded' || rf === am) && (r.status !== 'partially_refunded' || (rf > 0 && rf < am)))) return 'intents__refunded__ck';
    if (nn(r.resolution_note) && r.resolution_note.length > 500) return 'intents__note__ck';
    if (!['user', 'system'].includes(r.created_actor_type)) return 'intents__actor__ck';
    return undefined;
  }
  if (t === 'payments.refunds') {                                   // PG-T14: 05-SCHEMA §6 refunds__*__ck (names copied)
    const st = ['pending_approval', 'approved', 'rejected', 'requested', 'held_for_review', 'completed', 'failed'];
    if (!(['manual', 'api'].includes(r.mode) && (r.mode === 'manual' || r.gateway === 'khalti'))) return 'refunds__mode__ck';
    if (!st.includes(r.status)) return 'refunds__status__ck';
    if (!(Number(r.amount_paisa) > 0)) return 'refunds__amount__ck';
    if ([r.reason_text, r.decision_note, r.failure_note].some((x) => nn(x) && String(x).length > 500)) return 'refunds__text__ck';
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(String(r.idempotency_key))) return 'refunds__idem__ck';
    if (nn(r.gateway_refund_reference) && !/^[A-Za-z0-9_.:/-]{1,100}$/.test(r.gateway_refund_reference)) return 'refunds__ref__ck';
    if (!['pending_approval', 'rejected'].includes(r.status) && !nn(r.approved_by_membership_id)) return 'refunds__approved__ck';
    if (r.status === 'completed' && !(nn(r.completed_at) && nn(r.ledger_entry_id))) return 'refunds__completed__ck';
    if ((nn(r.held_reason) && !['refund_not_visible', 'refund_kind_mismatch', 'api_outcome_unknown'].includes(r.held_reason)) || (r.status === 'held_for_review' && !nn(r.held_reason))) return 'refunds__held__ck';
    if (r.status === 'failed' && !nn(r.failure_reason)) return 'refunds__failed__ck';
    if (nn(r.failure_reason) && !/^[a-z0-9_]{1,64}$/.test(r.failure_reason)) return 'refunds__failure_code__ck';
    if (!(Number(r.unconfirmed_run_count) >= 0)) return 'refunds__unconfirmed__ck';
    return undefined;
  }
  if (t === 'payments.reconciliation_runs') {                        // PG-T13: reconciliation_runs__*__ck
    if (!['cron', 'manual'].includes(r.trigger)) return 'reconciliation_runs__trigger__ck';
    if (!['running', 'completed', 'failed'].includes(r.status)) return 'reconciliation_runs__status__ck';
    if (![r.checked_count, r.ok_count, r.findings_count, r.critical_count].every((n) => Number(n) >= 0)) return 'reconciliation_runs__counts__ck';
    return undefined;
  }
  if (t === 'payments.reconciliation_findings') {                    // PG-T13: reconciliation_findings__*__ck
    if (!nn(r.intent_id) && !nn(r.refund_id)) return 'reconciliation_findings__subject__ck';
    if (!['info', 'warning', 'critical'].includes(r.severity)) return 'reconciliation_findings__severity__ck';
    if (!['none', 'settled', 'held', 'ledger_repaired'].includes(r.auto_action)) return 'reconciliation_findings__auto__ck';
    if (!['open', 'resolved'].includes(r.status) || (r.status === 'resolved' && !(nn(r.resolution_code) && nn(r.resolved_by) && nn(r.resolved_at)))) return 'reconciliation_findings__status__ck';
    if (nn(r.note) && String(r.note).length > 1000) return 'reconciliation_findings__note__ck';
    return undefined;
  }
  if (t === 'payments.intent_transitions') {
    if (!['create', 'callback', 'poll', 'verify_call', 'recheck', 'resolve', 'cancel', 'reconciliation', 'refund', 'sweep'].includes(r.cause)) return 'intent_transitions__cause__ck';
    if (!['user', 'system'].includes(r.actor_type)) return 'intent_transitions__actor__ck';
    return undefined;
  }
  if (t === 'payments.gateway_calls') {
    if (!['esewa', 'khalti', 'fonepay'].includes(r.gateway)) return 'gateway_calls__gateway__ck';
    if (!['khalti_initiate', 'khalti_lookup', 'esewa_status', 'khalti_refund', 'credential_test'].includes(r.operation)) return 'gateway_calls__op__ck';
    if (!['answer', 'service_unavailable', 'timeout', 'network_error', 'http_error', 'auth_error', 'not_found', 'invalid_response'].includes(r.outcome)) return 'gateway_calls__outcome__ck';
    return undefined;
  }
  if (t === 'payments.callbacks') {
    if (!['esewa_success', 'esewa_failure', 'khalti_return', 'launch'].includes(r.kind)) return 'callbacks__kind__ck';
    if (!['ok', 'payments.signature_invalid', 'payments.callback_mismatch', 'payments.callback_stale', 'rate_limited'].includes(r.outcome_code)) return 'callbacks__outcome__ck';
    const q = typeof r.query_redacted === 'string' ? JSON.parse(r.query_redacted) : r.query_redacted;       // node-pg sends jsonb as text or object
    if (nn(q) && Object.hasOwn(q, 'mobile')) return 'callbacks__no_mobile__ck';
    if (nn(q) && JSON.stringify(q).length > 6144) return 'callbacks__size__ck';
    return undefined;
  }
  if (t !== 'payments.merchant_accounts') return undefined;
  if (!['esewa', 'khalti', 'fonepay'].includes(r.gateway)) return 'merchant_accounts__gateway__ck';
  if (!['uat', 'production'].includes(r.environment)) return 'merchant_accounts__env__ck';
  if (r.gateway === 'fonepay' && r.is_enabled) return 'merchant_accounts__fonepay_off__ck';
  if (nn(r.esewa_product_code) && !(r.gateway === 'esewa' && /^[A-Za-z0-9_-]{1,64}$/.test(r.esewa_product_code))) return 'merchant_accounts__esewa_code__ck';
  if (nn(r.khalti_website_url) && !(r.gateway === 'khalti' && /^https:\/\//.test(r.khalti_website_url) && r.khalti_website_url.length <= 300)) return 'merchant_accounts__khalti_url__ck';
  const secretCols = ['secret_ciphertext', 'secret_nonce', 'secret_auth_tag', 'secret_kek_id', 'secret_fingerprint'];
  const none = secretCols.every((c) => !nn(r[c]));
  const all = nn(r.secret_ciphertext) && r.secret_nonce?.length === 12 && r.secret_auth_tag?.length === 16 && /^[A-Za-z0-9_-]{1,32}$/.test(String(r.secret_kek_id)) && /^[0-9a-f]{8}$/.test(String(r.secret_fingerprint));
  if (!none && !all) return 'merchant_accounts__secret_shape__ck';
  if (r.is_enabled && !(nn(r.secret_ciphertext) && ((r.gateway === 'esewa' && nn(r.esewa_product_code)) || (r.gateway === 'khalti' && nn(r.khalti_website_url))))) return 'merchant_accounts__enabled_complete__ck';
  if (r.api_refunds_enabled && r.gateway !== 'khalti') return 'merchant_accounts__api_refunds__ck';
  if (nn(r.last_test_outcome) && !['reachable_key_valid', 'reachable_key_unverifiable', 'auth_failed', 'unreachable'].includes(r.last_test_outcome)) return 'merchant_accounts__test__ck';
  return undefined;
}
const uniq = (t: Table, rows: Row[], r: Row, self?: Row): string | undefined => {
  const dup = (f: (x: Row) => boolean) => rows.some((x) => x !== self && f(x));
  if (t === 'payments.merchant_accounts') {
    if (dup((x) => x.id === r.id)) return 'merchant_accounts__pk';
    if (dup((x) => x.tenant_id === r.tenant_id && x.gateway === r.gateway && x.environment === r.environment)) return 'merchant_accounts__slot__uq';
  }
  if (t === 'payments.settings' && dup((x) => x.tenant_id === r.tenant_id)) return 'settings__pk';
  if (t === 'payments.intents') {
    const open = ['created', 'initiated', 'pending'];
    if (dup((x) => x.id === r.id)) return 'intents__pk';
    if (dup((x) => x.tenant_id === r.tenant_id && x.idempotency_key === r.idempotency_key)) return 'intents__tenant_id_idempotency_key__uq';
    if (open.includes(r.status) && dup((x) => x.tenant_id === r.tenant_id && x.order_id === r.order_id && open.includes(x.status))) return 'intents__tenant_id_order_id__open__p_uq';
    if (nn(r.gateway_txn_ref) && dup((x) => x.tenant_id === r.tenant_id && x.gateway === r.gateway && x.gateway_txn_ref === r.gateway_txn_ref)) return 'intents__tenant_id_gateway_txn__p_uq';
    if (dup((x) => same(x.callback_token_sha256, r.callback_token_sha256))) return 'intents__callback_token_sha256__uq';
  }
  if ((t === 'payments.intent_transitions' || t === 'payments.gateway_calls' || t === 'payments.callbacks') && dup((x) => x.id === r.id)) return `${t.split('.')[1]}__pk`;
  if (t === 'payments.refunds') {                                   // PG-T14: pk, in-flight partial unique (one per intent), unique (tenant, idempotency_key)
    const inflight = ['pending_approval', 'approved', 'requested', 'held_for_review'];
    if (dup((x) => x.id === r.id)) return 'refunds__pk';
    if (dup((x) => x.tenant_id === r.tenant_id && x.idempotency_key === r.idempotency_key)) return 'refunds__tenant_id_idempotency_key__uq';
    if (inflight.includes(r.status) && dup((x) => x.tenant_id === r.tenant_id && x.intent_id === r.intent_id && inflight.includes(x.status))) return 'refunds__tenant_id_intent_inflight__p_uq';
  }
  if ((t === 'payments.reconciliation_runs' || t === 'payments.reconciliation_findings' || t === 'test.markers') && dup((x) => x.id === r.id)) return t.split('.')[1] + '__pk';
  if (t === 'payments.reconciliation_runs' && r.status === 'running' && dup((x) => x.tenant_id === r.tenant_id && x.status === 'running')) return 'reconciliation_runs__tenant_id_running__p_uq';   // one running run per tenant
  return undefined;
};

// intents__mutable_columns + intents__transition_guard (05-SCHEMA §6): P0001 'immutable_row' / 'invalid_transition'.
const MUTABLE = new Set(['status', 'gateway_txn_ref', 'gateway_secondary_ref', 'gateway_payment_url', 'expires_at', 'initiated_at', 'pending_at', 'settled_at', 'closed_at',
  'last_checked_at', 'check_count', 'consecutive_unknown', 'last_gateway_status_raw', 'verified_amount_paisa', 'verification_method', 'hold_reason', 'failure_reason',
  'resolution_reason_code', 'resolution_note', 'resolved_by', 'resolved_at', 'ledger_entry_id', 'refunded_paisa', 'updated_at', 'updated_by', 'version']);
const TRANSITIONS: [string[], string[]][] = [[['created'], ['initiated', 'failed']], [['initiated', 'pending'], ['pending', 'settled', 'failed', 'expired', 'held_for_review']],
  [['held_for_review'], ['settled', 'failed']], [['failed', 'expired'], ['held_for_review']], [['settled'], ['partially_refunded', 'refunded']], [['partially_refunded'], ['refunded']]];
// refunds__mutable_columns + refunds__transition_guard (05-SCHEMA §6).
const REFUND_MUTABLE = new Set(['status', 'approved_by_membership_id', 'approved_at', 'rejected_by_membership_id', 'rejected_at', 'reject_reason_code', 'decision_note', 'gateway_refund_reference',
  'refunded_on', 'confirmed_by_membership_id', 'confirmed_at', 'completed_at', 'ledger_entry_id', 'failure_reason', 'failure_note', 'held_reason', 'last_checked_at', 'unconfirmed_run_count',
  'updated_at', 'updated_by', 'version']);
const FINDING_MUTABLE = new Set(['status', 'resolution_code', 'note', 'resolved_by', 'resolved_at', 'updated_at', 'updated_by', 'version']);   // reconciliation_findings__mutable_columns
const REFUND_TRANSITIONS: [string[], string[]][] = [[['pending_approval'], ['rejected', 'approved']], [['approved'], ['requested']], [['requested'], ['completed', 'held_for_review', 'failed']], [['held_for_review'], ['completed', 'failed']]];
function guard(t: Table, old: Row, next: Row): void {
  if (t === 'payments.intent_transitions' || t === 'payments.gateway_calls' || t === 'payments.callbacks') throw pgError('42501', `permission denied for table ${t.split('.')[1]}`); // append-only: INSERT + SELECT only
  if (t === 'payments.refunds') {
    for (const c of TABLES[t]) if (!REFUND_MUTABLE.has(c) && !same(old[c], next[c])) throw pgError('P0001', 'immutable_row');
    if (old.status !== next.status && !REFUND_TRANSITIONS.some(([from, to]) => from.includes(old.status) && to.includes(next.status))) throw pgError('P0001', 'invalid_transition');
    return;
  }
  if (t === 'payments.reconciliation_findings') { for (const c of TABLES[t]) if (!FINDING_MUTABLE.has(c) && !same(old[c], next[c])) throw pgError('P0001', 'immutable_row'); return; }
  if (t !== 'payments.intents') return;
  for (const c of TABLES[t]) if (!MUTABLE.has(c) && !same(old[c], next[c])) throw pgError('P0001', 'immutable_row');
  for (const c of ['gateway_txn_ref', 'gateway_payment_url', 'expires_at']) if (nn(old[c]) && !same(old[c], next[c])) throw pgError('P0001', 'immutable_row');
  if (old.status !== next.status && !TRANSITIONS.some(([from, to]) => from.includes(old.status) && to.includes(next.status))) throw pgError('P0001', 'invalid_transition');
}

// node-pg typing: timestamptz -> Date on the way out of the store (strings the service wrote are parsed), bigint -> decimal STRING (pg's default for int8).
const BIGINT_COLS = new Set(['amount_paisa', 'verified_amount_paisa', 'refunded_paisa', 'our_amount_paisa', 'gateway_amount_paisa']);
const toDates = (row: Row): void => { for (const c of Object.keys(row)) if (/_at$/.test(c) && typeof row[c] === 'string') row[c] = new Date(row[c]); };
const pgOut = (t: Table, rows: Row[]): Row[] => (t !== 'payments.intents' && t !== 'payments.refunds' && t !== 'payments.reconciliation_findings' ? rows : rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, BIGINT_COLS.has(k) && v !== null && v !== undefined ? String(v) : v]))));

// ---------------------------------------------------------------- expression / condition evaluation
const unsupported = (sql: string): never => { throw new Error(`fake: unsupported SQL: ${sql.slice(0, 160)}`); };
const stripCasts = (s: string) => s.replace(/::\s*[a-z_]+(\[\])?/gi, '');
const splitTop = (s: string, sep: RegExp): string[] => s.split(sep).map((x) => x.trim()).filter(Boolean);
function evalExpr(e: string, vals: readonly unknown[], row: Row | undefined, now: Date, sql: string): unknown {
  const x = e.trim();
  let m: RegExpMatchArray | null;
  if ((m = x.match(/^\$(\d+)$/))) return vals[Number(m[1]) - 1];
  if (/^now\(\)$/i.test(x) || /^(clock_timestamp|statement_timestamp|transaction_timestamp)\(\)$/i.test(x)) return now;
  if (/^null$/i.test(x)) return null;
  if (/^true$/i.test(x)) return true;
  if (/^false$/i.test(x)) return false;
  if (/^-?\d+$/.test(x)) return Number(x);
  if ((m = x.match(/^'((?:[^']|'')*)'$/))) return m[1]!.replaceAll("''", "'");
  if ((m = x.match(/^(?:[a-z_]+\.)?([a-z_]+)\s*\+\s*(\d+|\$\d+)$/i)) && row) return Number(row[m[1]!]) + Number(m[2]!.startsWith('$') ? vals[Number(m[2]!.slice(1)) - 1] : m[2]);   // PG-T13: col + $n
  if ((m = x.match(/^(?:[a-z_]+\.)?([a-z_]+)$/i)) && row && m[1]! in row) return row[m[1]!];
  return unsupported(sql);
}
const same = (a: unknown, b: unknown): boolean => {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
};
const order = (a: unknown, b: unknown): number => {
  if (a instanceof Date || b instanceof Date) return new Date(a as any).getTime() - new Date(b as any).getTime();
  if (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b))) return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
function matches(where: string | undefined, vals: readonly unknown[], row: Row, now: Date, sql: string): boolean {
  if (!where) return true;
  return splitTop(stripCasts(where), /\s+and\s+/i).every((c) => {
    let m: RegExpMatchArray | null;
    const col = (n: string) => row[n.split('.').pop()!];
    if ((m = c.match(/^([\w.]+)\s+IS\s+(NOT\s+)?NULL$/i))) return (m[2] ? nn(col(m[1]!)) : !nn(col(m[1]!)));
    if ((m = c.match(/^([\w.]+)\s+IS\s+(NOT\s+)?DISTINCT\s+FROM\s+(.+)$/i))) { const eq = same(col(m[1]!) ?? null, evalExpr(m[3]!, vals, row, now, sql) ?? null); return m[2] ? eq : !eq; }
    if ((m = c.match(/^([\w.]+)\s*=\s*ANY\s*\(\s*\$(\d+)\s*\)$/i))) return ((vals[Number(m[2]) - 1] as unknown[]) ?? []).some((v) => same(col(m![1]!), v));
    if ((m = c.match(/^([\w.]+)\s*(<>|!=|<=|>=|=|<|>)\s*(.+)$/))) {
      const l = col(m[1]!); const r = evalExpr(m[3]!, vals, row, now, sql);
      if (!nn(l) || !nn(r)) return false;                                  // SQL three-valued logic: comparison with NULL is never true
      if (m[2] === '=') return same(l, r);
      if (m[2] === '<>' || m[2] === '!=') return !same(l, r);
      const cmp = order(l, r);                                             // PG-T11: ordering comparisons (timestamptz / bigint-as-text / text)
      return m[2] === '<' ? cmp < 0 : m[2] === '<=' ? cmp <= 0 : m[2] === '>' ? cmp > 0 : cmp >= 0;
    }
    return unsupported(sql);
  });
}

// ---------------------------------------------------------------- the fake
export interface Stmt { text: string; values: unknown[]; tenantId: string }
export interface AccessRow { action: string; entityType: string; entityId?: string; outcome: string; detail: Record<string, unknown> }

export function makeMerchantDb(seed: { merchant_accounts?: Row[]; settings?: Row[]; intents?: Row[] } = {}) {
  const store: Record<Table, Row[]> = {
    'payments.merchant_accounts': (seed.merchant_accounts ?? []).map((r) => ({ ...r })),
    'payments.settings': (seed.settings ?? []).map((r) => ({ ...r })),
    'audit.access_log': [],
    'payments.intents': (seed.intents ?? []).map((r) => ({ ...r })),
    'payments.intent_transitions': [],
    'payments.gateway_calls': [],
    'payments.callbacks': [],
    'payments.g_cs_reasons': [],
    'payments.cs_reasons': [],
    'payments.refunds': [],
    'payments.reconciliation_runs': [],
    'payments.reconciliation_findings': [],
    'test.markers': [],
  };
  const stmts: Stmt[] = [];
  const logs: unknown[] = [];
  // Transactions are serialised (a model of row locking: a later run() starts from the earlier run's committed state). The interleaving races
  // themselves (FOR UPDATE, version predicate) are only provable on a real DB, which needs the C0 payments DDL (not in the repo yet).
  let chain: Promise<unknown> = Promise.resolve();

  function makeTx(tenantId: string, work: Record<Table, Row[]>, clock: () => Date) {
    return {
      async query(text: string, values: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
        stmts.push({ text, values: [...values], tenantId });
        const sql = stripCasts(text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, ''));
        const now = clock();
        const tbl = (n: string): Table => { const k = n.toLowerCase() as Table; if (!(k in TABLES)) unsupported(text); return k; };
        const project = (rows: Row[], cols: string | undefined) => (!cols ? [] : cols.trim() === '*' ? rows.map((r) => ({ ...r })) : rows.map((r) => Object.fromEntries(
          splitTop(cols, /,/).map((c) => { const [e, a] = c.split(/\s+as\s+/i); return [(a ?? e!).trim().split('.').pop()!, r[e!.trim().split('.').pop()!]]; }))));
        let m: RegExpMatchArray | null;

        // PG-T09 / CR-C15-004: app.payments_resolve_callback_token(bytea) RETURNS TABLE (tenant_id, intent_id). SECURITY DEFINER: sees every tenant's intents, but returns only
        // a live token's row (32-byte hash, created <= 30 days ago; an intent without created_at counts as created now). Dialect: SELECT <cols|*> FROM app.payments_resolve_callback_token($1)
        if ((m = sql.match(/^select (.+?) from app\.payments_resolve_callback_token\s*\(\s*\$1\s*\)$/i))) {
          const hash = values[0];
          const live = Buffer.isBuffer(hash) && hash.length === 32
            ? work['payments.intents'].filter((r) => same(r.callback_token_sha256, hash) && now.getTime() - new Date(r.created_at ?? now).getTime() <= 30 * 86_400_000) : [];
          const out = project(live.map((r) => ({ tenant_id: r.tenant_id, intent_id: r.id })), m[1]);
          return { rows: out, rowCount: out.length };
        }
        if ((m = sql.match(/^select (.+?) from ([\w.]+)(?: where (.+?))?(?: order by (.+?))?(?: limit (\d+))?(?: for update)?$/i))) {
          const t = tbl(m[2]!);
          let rows = work[t].filter((r) => (GLOBAL_TABLES.includes(t) || r.tenant_id === tenantId) && matches(m![3], values, r, now, text));
          if (m[4]) for (const o of [...splitTop(m[4], /,/)].reverse()) {
            const [c, d] = o.split(/\s+/); const desc = /desc/i.test(d ?? '');
            rows = [...rows].sort((a, b) => (a[c!.split('.').pop()!] > b[c!.split('.').pop()!] ? 1 : a[c!.split('.').pop()!] < b[c!.split('.').pop()!] ? -1 : 0) * (desc ? -1 : 1));
          }
          if (m[5]) rows = rows.slice(0, Number(m[5]));
          const out = pgOut(t, project(rows, m[1]));
          return { rows: out, rowCount: out.length };
        }
        if ((m = sql.match(/^insert into ([\w.]+) \(([^)]+)\) values \((.+?)\)(?: on conflict(?: \([^)]*\))? do nothing)?(?: returning (.+))?$/i))) {
          const t = tbl(m[1]!);
          const cols = splitTop(m[2]!, /,/);
          const exprs = splitTop(m[3]!, /,(?![^(]*\))/);
          if (cols.length !== exprs.length) unsupported(text);
          const row: Row = { ...DEFAULTS[t]() };
          cols.forEach((c, i) => { if (!(TABLES[t] as readonly string[]).includes(c)) throw pgError('42703', `column "${c}" does not exist`); row[c] = evalExpr(exprs[i]!, values, undefined, now, text); });
          if (t !== 'audit.access_log') { row.created_at ??= now; row.updated_at ??= now; }
          if (t === 'payments.callbacks') row.received_at ??= now;
          for (const c of TABLES[t]) row[c] ??= null;
          toDates(row);
          if (GLOBAL_TABLES.includes(t)) throw pgError('42501', `permission denied for table ${t.split('.')[1]}`);   // g_cs_reasons: SELECT only (05-SCHEMA §3)
          if (row.tenant_id !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
          const nul = NOT_NULL[t].find((c) => !nn(row[c]));
          if (nul) throw pgError('23502', `null value in column "${nul}"`);
          if (t === 'payments.callbacks' && !work['payments.intents'].some((i) => i.tenant_id === row.tenant_id && i.id === row.intent_id)) throw pgError('23503', 'violates foreign key callbacks__intent__fk', 'callbacks__intent__fk');
          if (t === 'payments.refunds' && !work['payments.intents'].some((i) => i.tenant_id === row.tenant_id && i.id === row.intent_id)) throw pgError('23503', 'violates foreign key refunds__intent__fk', 'refunds__intent__fk');
          if (t === 'payments.reconciliation_findings' && !work['payments.reconciliation_runs'].some((x) => x.tenant_id === row.tenant_id && x.id === row.run_id)) throw pgError('23503', 'violates foreign key reconciliation_findings__run__fk', 'reconciliation_findings__run__fk');
          if (t === 'payments.reconciliation_findings' && nn(row.intent_id) && !work['payments.intents'].some((x) => x.tenant_id === row.tenant_id && x.id === row.intent_id)) throw pgError('23503', 'violates foreign key reconciliation_findings__intent__fk', 'reconciliation_findings__intent__fk');
          if (t === 'payments.reconciliation_findings' && nn(row.refund_id) && !work['payments.refunds'].some((x) => x.tenant_id === row.tenant_id && x.id === row.refund_id)) throw pgError('23503', 'violates foreign key reconciliation_findings__refund__fk', 'reconciliation_findings__refund__fk');
          if (t === 'payments.refunds') { const bad0 = checks(t, row); if (bad0) throw pgError('23514', `violates check constraint ${bad0}`, bad0); }   // PG checks CHECKs before unique indexes
          const dupe = uniq(t, work[t], row);
          if (dupe) { if (/on conflict/i.test(sql)) return { rows: [], rowCount: 0 }; throw pgError('23505', `duplicate key ${dupe}`, dupe); }
          const bad = checks(t, row);
          if (bad) throw pgError('23514', `violates check constraint ${bad}`, bad);
          work[t].push(row);
          const out = pgOut(t, project([row], m[4]));
          return { rows: out, rowCount: 1 };
        }
        if ((m = sql.match(/^update ([\w.]+) set (.+?) where (.+?)(?: returning (.+))?$/i))) {
          const t = tbl(m[1]!);
          const sets = splitTop(m[2]!, /,(?![^(]*\))/).map((s) => { const k = s.match(/^([a-z_]+)\s*=\s*(.+)$/i); return k ? [k[1]!, k[2]!] as const : unsupported(text); });
          const hit = work[t].filter((r) => r.tenant_id === tenantId && matches(m![3], values, r, now, text));
          for (const r of hit) {
            const next: Row = { ...r };
            for (const [c, e] of sets) { if (!(TABLES[t] as readonly string[]).includes(c)) throw pgError('42703', `column "${c}" does not exist`); next[c] = evalExpr(e, values, r, now, text); }
            toDates(next);
            guard(t, r, next);
            const nul = NOT_NULL[t].find((c) => !nn(next[c]));
            if (nul) throw pgError('23502', `null value in column "${nul}"`);
            const dupe = uniq(t, work[t], next, r);
            if (dupe) throw pgError('23505', `duplicate key ${dupe}`, dupe);
            const bad = checks(t, next);
            if (bad) throw pgError('23514', `violates check constraint ${bad}`, bad);
            Object.assign(r, next);
          }
          const out = pgOut(t, project(hit, m[4]));
          return { rows: out, rowCount: hit.length };
        }
        return unsupported(text);
      },
    };
  }

  /** Runs fn in one transaction for `tenantId`. The ctx has the real core `ctx.audit.access` (so its validation applies) writing audit.access_log on ctx.tx. */
  async function run<T>(fn: (ctx: any) => Promise<T>, o: { tenantId?: string; rollback?: boolean; permissions?: string[]; now?: () => Date } = {}): Promise<T> {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      const tenantId = o.tenantId ?? TENANT_A;
      const clock = o.now ?? (() => NOW);
      const work = Object.fromEntries((Object.keys(store) as Table[]).map((t) => [t, store[t].map((r) => ({ ...r }))])) as Record<Table, Row[]>;
      const tx = makeTx(tenantId, work, clock);
      const ctx: any = { tenantId, requestId: randomUUID(), actor: { type: 'user', id: USER, membershipId: USER }, tx, now: () => clock().toISOString(), permissions: o.permissions };
      ctx.audit = { access: (entry: any) => access(ctx, entry) };
      // ctx.db.tx = SAVEPOINT / ROLLBACK TO (C0 TRD §6, 08 A19 P-44): a throw inside restores every table to its state at entry, then rethrows.
      ctx.db = { tx: async (f: (c: any) => Promise<any>) => {
        const snap = Object.fromEntries((Object.keys(work) as Table[]).map((t) => [t, work[t].map((r) => ({ ...r }))])) as Record<Table, Row[]>;
        try { return await f(ctx); } catch (e) { for (const t of Object.keys(snap) as Table[]) work[t] = snap[t]; throw e; }
      } };
      const rec = (...a: unknown[]) => { logs.push(a); };
      ctx.log = { info: rec, warn: rec, error: rec, debug: rec };
      const out = await fn(ctx);
      if (!o.rollback) for (const t of Object.keys(store) as Table[]) store[t] = work[t];
      return out;
    } finally { release(); }
  }

  const accessRows = (tenantId = TENANT_A): AccessRow[] => store['audit.access_log'].filter((r) => r.tenant_id === tenantId).map((r) => ({
    action: r.action, entityType: r.entity_type, entityId: r.entity_id ?? undefined, outcome: r.outcome, detail: r.detail }));
  return {
    run, stmts, logs, accessRows,
    accounts: (tenantId = TENANT_A) => store['payments.merchant_accounts'].filter((r) => r.tenant_id === tenantId),
    intents: (tenantId = TENANT_A) => store['payments.intents'].filter((r) => r.tenant_id === tenantId),
    transitions: (tenantId = TENANT_A) => store['payments.intent_transitions'].filter((r) => r.tenant_id === tenantId),
    gatewayCalls: (tenantId = TENANT_A) => store['payments.gateway_calls'].filter((r) => r.tenant_id === tenantId),
    callbacks: (tenantId = TENANT_A) => store['payments.callbacks'].filter((r) => r.tenant_id === tenantId),
    refunds: (tenantId = TENANT_A) => store['payments.refunds'].filter((r) => r.tenant_id === tenantId),
    runs: (tenantId = TENANT_A) => store['payments.reconciliation_runs'].filter((r) => r.tenant_id === tenantId),            // PG-T13
    findings: (tenantId = TENANT_A) => store['payments.reconciliation_findings'].filter((r) => r.tenant_id === tenantId),
    markers: (tenantId = TENANT_A) => store['test.markers'].filter((r) => r.tenant_id === tenantId),
    /** Test seeding of any table row (tenant defaults to A); bypasses CHECKs on purpose (arrange step). */
    put: (table: Table, row: Row) => {
      const r = { ...Object.fromEntries((TABLES[table] as readonly string[]).map((c) => [c, null])), ...DEFAULTS[table](), ...row };
      if (table === 'payments.refunds') r.idempotency_key ??= `refund:${r.id}`;           // PG-T14: seeded rows get the real key shape ('refund:' || id)
      store[table].push(r);
    },
    settings: (tenantId = TENANT_A) => store['payments.settings'].filter((r) => r.tenant_id === tenantId),
    /** Every value the service ever sent to the database, flattened (Buffers also as utf8/base64/hex text) — for planted-secret scans. */
    sentText: (): string => stmts.map((s) => JSON.stringify(s.values.map((v) => (Buffer.isBuffer(v) ? `${v.toString('utf8')}|${v.toString('base64')}|${v.toString('hex')}` : v)))).join('\n'),
    /** Everything stored, flattened with the same Buffer treatment, EXCLUDING the secret ciphertext/nonce/tag columns themselves. */
    storedText: (): string => JSON.stringify(Object.values(store).flat().map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !/^secret_(ciphertext|nonce|auth_tag)$/.test(k))))),
  };
}
export type MerchantDb = ReturnType<typeof makeMerchantDb>;
export { UUIDV7 };
