'use server';
// Server actions for the front-desk client components (registration, order, patient, worklist, approvals). Errors become
// { ok:false, status, code, title } because a thrown ApiError loses its code across the action boundary in production.
// Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { printInvoice } from '@/features/billing/server/write.server';
import { getDiscountApproval, listDiscountReasons, listPaymentMethods, searchCreditParties, searchDoctors, searchOrderables, searchPatients } from './read.server';
import {
  approveDiscount, cancelOrder, changeOrderItems, createRegistration, quoteOrderItemsChange, quoteRegistration, recordPatientConsent, recordPayment,
  rejectDiscount, requestDiscountApproval, requestLabelPrints, resolveOrderFlag, updatePatient, uploadTrf,
} from './write.server';
import type { ActionResult, CodedSetEntry, Consents, CreditPartySummary, DiscountApprovalIn, DoctorSummary, InvoicePrintDoc, LabelReadiness, OrderableSummary, PatientSummary, Quote, RegisterBody, RegistrationDraft, RegistrationResult } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const p = e.problem;
      return { ok: false, status: e.status, code: p.code, title: p.title, ...(typeof p['detail'] === 'string' ? { detail: p['detail'] } : {}), ...(Array.isArray(p['errors']) ? { errors: p['errors'] as { path: string; code: string }[] } : {}) };
    }
    throw e;
  }
}
type Add = { orderable_id: string; priority: 'routine' | 'urgent' }[];

export async function searchPatientsAction(query: string): Promise<ActionResult<PatientSummary[]>> { return run(() => searchPatients(query)); }
export async function searchOrderablesAction(q: string): Promise<ActionResult<OrderableSummary[]>> { return run(() => searchOrderables(q)); }
export async function searchDoctorsAction(q: string): Promise<ActionResult<DoctorSummary[]>> { return run(() => searchDoctors(q)); }
export async function searchCreditPartiesAction(q: string): Promise<ActionResult<CreditPartySummary[]>> { return run(() => searchCreditParties(q)); }
export async function listPaymentMethodsAction(): Promise<ActionResult<CodedSetEntry[]>> { return run(() => listPaymentMethods()); }
export async function quoteRegistrationAction(draft: RegistrationDraft): Promise<ActionResult<Quote>> { return run(() => quoteRegistration(draft)); }
export async function createRegistrationAction(body: RegisterBody, key: string): Promise<ActionResult<RegistrationResult>> { return run(() => createRegistration(body, key)); }
export async function requestDiscountApprovalAction(b: DiscountApprovalIn, key: string): Promise<ActionResult<{ id: string }>> { return run(() => requestDiscountApproval(b, key)); }
export async function printInvoiceAction(invoiceId: string, reasonCode: string, key: string): Promise<ActionResult<InvoicePrintDoc>> { return run(() => printInvoice(invoiceId, reasonCode, key)); }
export async function requestLabelPrintsAction(orderId: string): Promise<ActionResult<LabelReadiness>> { return run(() => requestLabelPrints(orderId)); }
export async function listDiscountReasonsAction(): Promise<ActionResult<CodedSetEntry[]>> { return run(() => listDiscountReasons()); }
export async function getDiscountApprovalAction(id: string): Promise<ActionResult<{ id: string; status?: string; state?: string }>> { return run(() => getDiscountApproval(id)); }

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
export async function recordPaymentAction(orderId: string, r: { method_code: string; amount_received_paisa: number; reference?: string }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await recordPayment(orderId, r, key), true as const));
}
export async function uploadTrfAction(centreId: string, orderId: string, form: FormData, key: string): Promise<ActionResult<true>> {
  const file = form.get('file');
  if (!(file instanceof File)) return { ok: false, status: 400, code: 'common.validation_failed' };
  return run(async () => (await uploadTrf(centreId, orderId, file, key), true as const));
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
