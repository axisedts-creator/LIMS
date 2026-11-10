'use server';
// Server actions for the front-desk client components. Errors become { ok:false, status, code } because a thrown ApiError loses its code
// across the action boundary in production. Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { approveDiscount, cancelOrder, changeOrderItems, confirmPreRegisteredOrder, quoteOrderItemsChange, recordPatientConsent, recordPayment, rejectDiscount, resolveOrderFlag, updatePatient, uploadTrf } from './write.server';
import type { ActionResult, Consents } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}
type Add = { orderable_id: string; priority: 'routine' | 'urgent' }[];

export async function cancelOrderAction(orderId: string, version: number, r: { reason_code: string; reason_text?: string }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await cancelOrder(orderId, version, r, key), true as const));
}
export async function quoteItemsChangeAction(orderId: string, add: Add): Promise<ActionResult<{ net_paisa: number; quote_fingerprint: string }>> {
  return run(async () => {
    const q = await quoteOrderItemsChange(orderId, add);
    return { net_paisa: q.totals.net.amount_paisa, quote_fingerprint: q.quote_fingerprint };
  });
}
export async function changeOrderItemsAction(orderId: string, version: number, r: { add?: Add; remove?: { order_item_id: string; reason_code: string }[]; quote_fingerprint?: string }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await changeOrderItems(orderId, version, r, key), true as const));
}
export async function confirmOrderAction(orderId: string, version: number, key: string): Promise<ActionResult<true>> {
  return run(async () => (await confirmPreRegisteredOrder(orderId, version, key), true as const));
}
export async function recordPaymentAction(orderId: string, r: { method_code: string; amount_received_paisa: number; reference?: string }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await recordPayment(orderId, r, key), true as const));
}
export async function uploadTrfAction(centreId: string, form: FormData, key: string): Promise<ActionResult<true>> {
  const file = form.get('file');
  if (!(file instanceof File)) return { ok: false, status: 400, code: 'common.validation_failed' };
  return run(async () => (await uploadTrf(centreId, file, key), true as const));
}
export async function updatePatientAction(patientId: string, version: number, changes: Record<string, string>): Promise<ActionResult<true>> {
  return run(async () => (await updatePatient(patientId, version, changes), true as const));
}
export async function recordConsentAction(patientId: string, c: Consents, key: string): Promise<ActionResult<true>> {
  return run(async () => (await recordPatientConsent(patientId, c, key), true as const));
}
export async function approveDiscountAction(id: string, version: number, key: string): Promise<ActionResult<true>> {
  return run(async () => (await approveDiscount(id, version, key), true as const));
}
export async function rejectDiscountAction(id: string, version: number, note: string, key: string): Promise<ActionResult<true>> {
  return run(async () => (await rejectDiscount(id, version, note, key), true as const));
}
export async function resolveFlagAction(id: string, version: number, resolutionCode: string, key: string): Promise<ActionResult<true>> {
  return run(async () => (await resolveOrderFlag(id, version, resolutionCode, key), true as const));
}
