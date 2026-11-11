'use server';
// Server actions for the payment buttons / forms. Only ApiError is mapped to { ok:false, status, code, latest? } (a thrown ApiError loses its
// code across the action boundary in production); anything else rethrows to the error boundary. Nothing but a status string / version / test outcome
// goes back to the browser: never a provider payload, a request body or a secret.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { previewStaticQr } from './read.server';
import {
  approveRefund, cancelIntent, confirmManualRefund, createRefund, createStaticQr, failRefund, putMerchantAccount, putPaymentSettings, recheckIntent, recheckRefund, rejectRefund,
  resolveFinding, resolveIntent, startReconciliation, testMerchantAccount, type AccountBody, type Resolution,
} from './write.server';

export type ActionResult =
  | { ok: true; status?: string; gateway?: string; version?: number; outcome?: string; entries?: number; totalPaisa?: number }
  | { ok: false; status: number; code: string; latest?: string };

const SAFE_ANSWER = /^[A-Za-z0-9 _.-]{1,40}$/;
const OUTCOMES = ['reachable_key_valid', 'reachable_key_unverifiable', 'auth_failed', 'unreachable'];
const GATEWAYS = ['esewa', 'khalti', 'fonepay'];
async function run(call: () => Promise<{ status?: string; gateway?: string; version?: number; outcome?: string } | undefined>): Promise<ActionResult> {
  try {
    const r = await call();
    return {
      ok: true,
      ...(typeof r?.status === 'string' ? { status: r.status } : {}),
      ...(typeof r?.gateway === 'string' && GATEWAYS.includes(r.gateway) ? { gateway: r.gateway } : {}),
      ...(typeof r?.version === 'number' && Number.isSafeInteger(r.version) ? { version: r.version } : {}),
      ...(typeof r?.outcome === 'string' && OUTCOMES.includes(r.outcome) ? { outcome: r.outcome } : {}),
    };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const raw = e.problem['latest_status'] ?? e.problem['gateway_status_raw'];
    return { ok: false, status: e.status, code: e.problem.code, ...(typeof raw === 'string' && SAFE_ANSWER.test(raw) ? { latest: raw } : {}) };
  }
}

export async function recheckAction(id: string): Promise<ActionResult> {
  return run(() => recheckIntent(id));
}
export async function resolveAction(id: string, version: number, resolution: Resolution, reasonCode: string, note: string | undefined, key: string): Promise<ActionResult> {
  return run(() => resolveIntent(id, version, resolution, reasonCode, note, key));
}
export async function cancelAction(id: string, reasonCode: string, key: string): Promise<ActionResult> {
  return run(() => cancelIntent(id, reasonCode, key));
}

// ---- PG-T19: refunds (P7b, P8–P11b) ----
export async function createRefundAction(intentId: string, amountPaisa: number, reasonCode: string, reasonText: string | undefined, key: string): Promise<ActionResult> {
  return run(() => createRefund(intentId, amountPaisa, reasonCode, reasonText, key));
}
export async function approveRefundAction(id: string, version: number, note: string | undefined, key: string): Promise<ActionResult> {
  return run(() => approveRefund(id, version, note, key));
}
export async function rejectRefundAction(id: string, version: number, reasonCode: string, note: string | undefined, key: string): Promise<ActionResult> {
  return run(() => rejectRefund(id, version, reasonCode, note, key));
}
export async function confirmRefundAction(id: string, version: number, reference: string, refundedOn: string, key: string): Promise<ActionResult> {
  return run(() => confirmManualRefund(id, version, reference, refundedOn, key));
}
export async function recheckRefundAction(id: string): Promise<ActionResult> {
  return run(() => recheckRefund(id));
}
export async function failRefundAction(id: string, version: number, reasonCode: string, note: string | undefined, key: string): Promise<ActionResult> {
  return run(() => failRefund(id, version, reasonCode, note, key));
}

// ---- reconciliation (P14, P16) ----
export async function startReconciliationAction(key: string): Promise<ActionResult> {
  return run(() => startReconciliation(key));
}
export async function resolveFindingAction(id: string, version: number, resolutionCode: string, note: string | undefined, key: string): Promise<ActionResult> {
  return run(() => resolveFinding(id, version, resolutionCode, note, key));
}

// ---- static-QR worksheet (P18, P19) ----
export async function previewStaticQrAction(businessDate: string, centreId: string | undefined): Promise<ActionResult> {
  try {
    const r = await previewStaticQr(businessDate, centreId);
    return { ok: true, entries: r.entries, totalPaisa: r.total.amount_paisa };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code };
  }
}
export async function saveStaticQrAction(d: { businessDate: string; centreId?: string; statementPaisa: number; reference: string; note?: string }, key: string): Promise<ActionResult> {
  return run(() => createStaticQr(d, key));
}

// ---- settings (P21–P23). The typed secret only travels inside this call's argument; it is never returned or logged. ----
export async function saveAccountAction(gateway: string, environment: string, version: number | undefined, body: AccountBody): Promise<ActionResult> {
  return run(() => putMerchantAccount(gateway, environment, version, body));
}
export async function testAccountAction(gateway: string, environment: string): Promise<ActionResult> {
  return run(() => testMerchantAccount(gateway, environment));
}
export async function saveSettingsAction(version: number, body: { thresholdPaisa: number; label: string; reconciliationEnabled: boolean }): Promise<ActionResult> {
  return run(() => putPaymentSettings(version, body));
}
