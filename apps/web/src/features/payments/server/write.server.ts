import 'server-only';
// P3 recheckPaymentIntent, P4 resolvePaymentIntent (If-Match + Idempotency-Key), P5 cancelPaymentIntent (Idempotency-Key).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const RESOLUTIONS = ['settle', 'fail', 'record_exceeding_due'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const path = (id: string, op: string) => {
  if (!UUID.test(id)) throw bad();
  return `/v1/payments/intents/${id}/${op}`;
};
const json = { 'content-type': 'application/json' };

export const recheckIntent = (id: string) => serverFetch<{ status?: string }>(path(id, 'recheck'), { method: 'POST', headers: json, body: '{}' });

export function resolveIntent(id: string, version: number, resolution: Resolution, reasonCode: string, note: string | undefined, key: string) {
  const p = path(id, 'resolve');
  if (!KEY.test(key) || !CODE.test(reasonCode) || !RESOLUTIONS.includes(resolution) || !Number.isSafeInteger(version) || version < 0) throw bad();
  const n = note?.trim();
  if (n && n.length > 500) throw bad();
  return serverFetch<{ status?: string }>(p, {
    method: 'POST',
    headers: { ...json, 'idempotency-key': key, 'if-match': `"${version}"` },
    body: JSON.stringify({ resolution, reason_code: reasonCode, ...(n ? { note: n } : {}) }),
  });
}

export function cancelIntent(id: string, reasonCode: string, key: string) {
  const p = path(id, 'cancel');
  if (!KEY.test(key) || !CODE.test(reasonCode)) throw bad();
  return serverFetch<{ status?: string }>(p, { method: 'POST', headers: { ...json, 'idempotency-key': key }, body: JSON.stringify({ reason_code: reasonCode }) });
}

// ---- PG-T19. Same rule as above: only a uuid reaches a path, every value is re-validated here (the browser is not trusted). ----
const REF = /^[A-Za-z0-9_.:/-]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE_ENV = /^(uat|production)$/;
const GATEWAYS = ['esewa', 'khalti', 'fonepay'] as const;
type Gateway = (typeof GATEWAYS)[number];
const MAX_PAISA = 9_007_199_254_740_991;
const note = (n: string | undefined, max: number) => {
  const t = n?.trim();
  if (t && t.length > max) throw bad();
  return t ? { note: t } : {};
};
const ver = (version: number) => {
  if (!Number.isSafeInteger(version) || version < 0) throw bad();
  return { 'if-match': `"${version}"` };
};
const idem = (key: string) => {
  if (!KEY.test(key)) throw bad();
  return { 'idempotency-key': key };
};
const refundPath = (id: string, op: string) => {
  if (!UUID.test(id)) throw bad();
  return `/v1/payments/refunds/${id}/${op}`;
};
type Out = { status?: string; gateway?: string };

/** P8 createPaymentRefundRequest. */
export function createRefund(intentId: string, amountPaisa: number, reasonCode: string, reasonText: string | undefined, key: string) {
  if (!UUID.test(intentId) || !Number.isSafeInteger(amountPaisa) || amountPaisa < 1 || amountPaisa > MAX_PAISA || !CODE.test(reasonCode)) throw bad();
  const t = reasonText?.trim();
  if (t && t.length > 500) throw bad();
  return serverFetch<Out>(`/v1/payments/intents/${intentId}/refunds`, {
    method: 'POST', headers: { ...json, ...idem(key) }, body: JSON.stringify({ refund_amount_paisa: amountPaisa, reason_code: reasonCode, ...(t ? { reason_text: t } : {}) }),
  });
}
/** P9 approve. */
export const approveRefund = (id: string, version: number, n: string | undefined, key: string) =>
  serverFetch<Out>(refundPath(id, 'approve'), { method: 'POST', headers: { ...json, ...idem(key), ...ver(version) }, body: JSON.stringify(note(n, 500)) });
/** P10 reject. */
export function rejectRefund(id: string, version: number, reasonCode: string, n: string | undefined, key: string) {
  if (!CODE.test(reasonCode)) throw bad();
  return serverFetch<Out>(refundPath(id, 'reject'), { method: 'POST', headers: { ...json, ...idem(key), ...ver(version) }, body: JSON.stringify({ reason_code: reasonCode, ...note(n, 500) }) });
}
/** P11 confirmManualPaymentRefund. */
export function confirmManualRefund(id: string, version: number, reference: string, refundedOn: string, key: string) {
  if (!REF.test(reference) || !DAY.test(refundedOn)) throw bad();
  return serverFetch<Out>(refundPath(id, 'confirm-manual'), {
    method: 'POST', headers: { ...json, ...idem(key), ...ver(version) }, body: JSON.stringify({ gateway_refund_reference: reference, refunded_on: refundedOn }),
  });
}
/** P7b recheckPaymentRefund. */
export const recheckRefund = (id: string) => serverFetch<Out>(refundPath(id, 'recheck'), { method: 'POST', headers: json, body: '{}' });
/** P11b failManualPaymentRefund. */
export function failRefund(id: string, version: number, reasonCode: string, n: string | undefined, key: string) {
  if (!CODE.test(reasonCode)) throw bad();
  return serverFetch<Out>(refundPath(id, 'fail'), { method: 'POST', headers: { ...json, ...idem(key), ...ver(version) }, body: JSON.stringify({ reason_code: reasonCode, ...note(n, 500) }) });
}

/** P14 startReconciliationRun (always "now"; the body is empty). */
export const startReconciliation = (key: string) => serverFetch<Out>('/v1/payments/reconciliation-runs', { method: 'POST', headers: { ...json, ...idem(key) }, body: '{}' });
/** P16 resolveReconciliationFinding. */
export function resolveFinding(id: string, version: number, resolutionCode: string, n: string | undefined, key: string) {
  if (!UUID.test(id) || !CODE.test(resolutionCode)) throw bad();
  return serverFetch<Out>(`/v1/payments/reconciliation-findings/${id}/resolve`, {
    method: 'POST', headers: { ...json, ...idem(key), ...ver(version) }, body: JSON.stringify({ resolution_code: resolutionCode, ...note(n, 1000) }),
  });
}

/** P19 createStaticQrReconciliation. */
export function createStaticQr(d: { businessDate: string; centreId?: string; statementPaisa: number; reference: string; note?: string }, key: string) {
  const ref = d.reference.trim();
  if (!DAY.test(d.businessDate) || (d.centreId !== undefined && !UUID.test(d.centreId)) || !Number.isSafeInteger(d.statementPaisa) || d.statementPaisa < 0 || !ref || ref.length > 100) throw bad();
  return serverFetch<Out>('/v1/payments/static-qr-reconciliations', {
    method: 'POST', headers: { ...json, ...idem(key) },
    body: JSON.stringify({ business_date: d.businessDate, ...(d.centreId ? { centre_id: d.centreId } : {}), statement_total_paisa: d.statementPaisa, statement_reference: ref, ...note(d.note, 1000) }),
  });
}

const gatewayPath = (gateway: string, environment: string, op = '') => {
  if (!GATEWAYS.includes(gateway as Gateway) || !CODE_ENV.test(environment)) throw bad();
  return `/v1/payments/merchant-accounts/${gateway}/${environment}${op}`;
};
export interface AccountBody { is_enabled: boolean; esewa_product_code?: string; khalti_website_url?: string; api_refunds_enabled?: boolean; secret?: string }
/** P21 putMerchantAccount: only allow-listed fields are forwarded; `secret` only when one was typed; no If-Match when the row does not exist yet. Fonepay is never written (B8). */
export function putMerchantAccount(gateway: string, environment: string, version: number | undefined, b: AccountBody) {
  const p = gatewayPath(gateway, environment);
  if (gateway === 'fonepay' || typeof b.is_enabled !== 'boolean') throw bad();
  const body: AccountBody = { is_enabled: b.is_enabled };
  if (b.esewa_product_code !== undefined) {
    if (gateway !== 'esewa' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.esewa_product_code)) throw bad();
    body.esewa_product_code = b.esewa_product_code;
  }
  if (b.khalti_website_url !== undefined) {
    if (gateway !== 'khalti' || b.khalti_website_url.length > 300 || !/^https:\/\/[^\s]+$/.test(b.khalti_website_url)) throw bad();
    body.khalti_website_url = b.khalti_website_url;
  }
  if (b.api_refunds_enabled !== undefined) {
    if (gateway !== 'khalti') throw bad();
    body.api_refunds_enabled = b.api_refunds_enabled === true;
  }
  if (b.secret !== undefined) {
    if (b.secret.length < 1 || b.secret.length > 256) throw bad();
    body.secret = b.secret;
  }
  return serverFetch<{ version?: number }>(p, { method: 'PUT', headers: { ...json, ...(version === undefined ? {} : ver(version)) }, body: JSON.stringify(body) });
}
/** P22 testMerchantAccount: no body, never the secret. */
export const testMerchantAccount = (gateway: string, environment: string) =>
  serverFetch<{ outcome?: string }>(gatewayPath(gateway, environment, '/test'), { method: 'POST', headers: json, body: '{}' });

/** P23 updatePaymentSettings. */
export function putPaymentSettings(version: number, b: { thresholdPaisa: number; label: string; reconciliationEnabled: boolean }) {
  if (!Number.isSafeInteger(b.thresholdPaisa) || b.thresholdPaisa < 0 || !/^[A-Za-z0-9 .,&()-]{1,50}$/.test(b.label)) throw bad();
  return serverFetch<{ version?: number }>('/v1/payments/settings', {
    method: 'PUT', headers: { ...json, ...ver(version) },
    body: JSON.stringify({ refund_two_person_threshold_paisa: b.thresholdPaisa, purchase_order_label: b.label, reconciliation_enabled: b.reconciliationEnabled === true }),
  });
}
