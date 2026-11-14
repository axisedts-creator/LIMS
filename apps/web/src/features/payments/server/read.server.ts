import 'server-only';
// P1 listPaymentIntents, P2 getPaymentIntent, P24 listPaymentCodes (BFF reads). Only a uuid ever reaches a path segment.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type {
  CodedValue, FindingDto, MerchantAccountDto, PaymentIntentDetail, PaymentIntentSummary, PaymentMoney, PaymentSettingsDto, ReconciliationRunDto, RefundDto, StaticQrReconDto,
} from '../types';

export interface IntentPage { data: PaymentIntentSummary[]; page?: { limit?: number; next_cursor?: string } }
export interface Page<T> { data: T[]; page?: { limit?: number; next_cursor?: string } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETS = [
  'hold_reasons', 'resolution_reasons', 'cancel_reasons', 'refund_reasons', 'refund_reject_reasons', 'refund_fail_reasons', 'refund_hold_reasons', 'finding_kinds', 'finding_resolutions',
] as const;
export type CodedSetName = (typeof SETS)[number];

export const listPaymentIntents = (q: URLSearchParams) => serverFetch<IntentPage>(`/v1/payments/intents?${q.toString()}`);

export function getPaymentIntent(id: string) {
  if (!UUID.test(id)) throw new ApiError(404, problem('common.not_found', 'Not found', 404)); // never forward a non-uuid into the path
  return serverFetch<PaymentIntentDetail>(`/v1/payments/intents/${id}`);
}

export async function listPaymentCodes(set: CodedSetName): Promise<CodedValue[]> {
  const r = await serverFetch<{ data?: CodedValue[] }>(`/v1/payments/coded-sets/${set}`);
  return (Array.isArray(r?.data) ? r.data : []).filter((c) => c && c.is_active !== false && typeof c.code === 'string');
}

// ---- PG-T19 reads. Every row is re-built from an allow-list so nothing else the API sends (tokens, payloads, secrets) can reach a client component. ----
const arr = <T,>(r: { data?: T[] } | undefined): T[] => (Array.isArray(r?.data) ? r!.data! : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const money = (v: unknown): PaymentMoney | undefined => {
  const m = v as { amount_paisa?: unknown } | undefined;
  return m && Number.isSafeInteger(m.amount_paisa) ? { amount_paisa: m.amount_paisa as number, currency: 'NPR' } : undefined;
};
const zero: PaymentMoney = { amount_paisa: 0, currency: 'NPR' };
const person = (v: unknown) => {
  const p = v as { membership_id?: unknown; display_name?: unknown } | undefined;
  return p && typeof p.membership_id === 'string' ? { membership_id: p.membership_id, display_name: str(p.display_name) ?? '' } : undefined;
};
const opt = <V,>(k: string, v: V | undefined): Record<string, V> => (v === undefined ? {} : { [k]: v });

const toRefund = (r: RefundDto): RefundDto => ({
  id: String(r.id), intent_id: String(r.intent_id), gateway: String(r.gateway), mode: String(r.mode), status: String(r.status), amount: money(r.amount) ?? zero,
  requested_at: String(r.requested_at), version: num(r.version) ?? 0,
  ...opt('order_id', str(r.order_id)), ...opt('reason_code', str(r.reason_code)), ...opt('requested_by', person(r.requested_by)), ...opt('approved_by', person(r.approved_by)),
  ...opt('approved_at', str(r.approved_at)), ...opt('held_reason', str(r.held_reason)),
});
const toRun = (r: ReconciliationRunDto): ReconciliationRunDto => ({
  id: String(r.id), business_date: String(r.business_date), trigger: String(r.trigger), status: String(r.status),
  ...opt('started_at', str(r.started_at)), ...opt('finished_at', str(r.finished_at)),
  ...(r.counts ? { counts: { checked: num(r.counts.checked) ?? 0, ok: num(r.counts.ok) ?? 0, findings: num(r.counts.findings) ?? 0, critical: num(r.counts.critical) ?? 0 } } : {}),
});
const toFinding = (f: FindingDto): FindingDto => ({
  id: String(f.id), kind: String(f.kind), severity: String(f.severity), created_at: String(f.created_at), version: num(f.version) ?? 0,
  ...opt('intent_id', str(f.intent_id)), ...opt('our_status', str(f.our_status)), ...opt('gateway_status_raw', str(f.gateway_status_raw)), ...opt('our_amount', money(f.our_amount)),
  ...opt('gateway_amount', money(f.gateway_amount)), ...opt('auto_action', str(f.auto_action)),
});
const toSheet = (s: StaticQrReconDto): StaticQrReconDto => ({
  id: String(s.id), business_date: String(s.business_date), created_at: String(s.created_at), status: String(s.status),
  system_total: money(s.system_total) ?? zero, statement_total: money(s.statement_total) ?? zero, difference: money(s.difference) ?? zero,
  ...opt('centre_id', str(s.centre_id)), ...opt('system_entries', num(s.system_entries)), ...opt('statement_reference', str(s.statement_reference)), ...opt('reconciled_by', person(s.reconciled_by)),
});
/** The secret never leaves the server: only is_set / set_at / fingerprint survive (REQ-SEC-058). */
const toAccount = (a: MerchantAccountDto): MerchantAccountDto => ({
  gateway: String(a.gateway), environment: String(a.environment), is_enabled: a.is_enabled === true,
  ...opt('esewa_product_code', str(a.esewa_product_code)), ...opt('khalti_website_url', str(a.khalti_website_url)),
  ...(typeof a.api_refunds_enabled === 'boolean' ? { api_refunds_enabled: a.api_refunds_enabled } : {}), ...opt('version', num(a.version)),
  secret: { is_set: a.secret?.is_set === true, ...opt('set_at', str(a.secret?.set_at)), ...opt('fingerprint', str(a.secret?.fingerprint)) },
});

const page = <T,>(r: Page<T> | undefined, f: (x: T) => T): { rows: T[]; next?: string } => {
  const next = str(r?.page?.next_cursor);
  return { rows: arr(r).map(f), ...(next ? { next } : {}) };
};

export const listPaymentRefunds = async (q: URLSearchParams) => page(await serverFetch<Page<RefundDto>>(`/v1/payments/refunds?${q.toString()}`), toRefund);
export const listReconciliationRuns = async (q: URLSearchParams) => page(await serverFetch<Page<ReconciliationRunDto>>(`/v1/payments/reconciliation-runs?${q.toString()}`), toRun);
export const listReconciliationFindings = async (q: URLSearchParams) => page(await serverFetch<Page<FindingDto>>(`/v1/payments/reconciliation-findings?${q.toString()}`), toFinding);
export const listStaticQrWorksheets = async (q: URLSearchParams) => page(await serverFetch<Page<StaticQrReconDto>>(`/v1/payments/static-qr-reconciliations?${q.toString()}`), toSheet);

export async function previewStaticQr(businessDate: string, centreId?: string): Promise<{ entries: number; total: PaymentMoney }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || (centreId !== undefined && !UUID.test(centreId))) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const q = new URLSearchParams({ business_date: businessDate });
  if (centreId) q.set('centre_id', centreId);
  const r = await serverFetch<{ system_entries?: number; system_total?: PaymentMoney }>(`/v1/payments/static-qr-reconciliations/preview?${q.toString()}`);
  const total = money(r?.system_total);
  if (!total) throw new ApiError(502, problem('common.dependency_unavailable', 'Unavailable', 502));
  return { entries: num(r?.system_entries) ?? 0, total };
}

export async function listMerchantAccounts(): Promise<MerchantAccountDto[]> {
  return arr(await serverFetch<{ data?: MerchantAccountDto[] }>('/v1/payments/merchant-accounts')).map(toAccount);
}

export async function getPaymentSettings(): Promise<PaymentSettingsDto> {
  const s = await serverFetch<PaymentSettingsDto>('/v1/payments/settings');
  return {
    refund_two_person_threshold: money(s?.refund_two_person_threshold) ?? zero, purchase_order_label: str(s?.purchase_order_label) ?? '',
    reconciliation_enabled: s?.reconciliation_enabled === true, version: num(s?.version) ?? 0,
  };
}
