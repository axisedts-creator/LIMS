'use server';
// Server actions for the front-desk client components (registration, order, patient, worklist, approvals). Errors become
// { ok:false, status, code, title } because a thrown ApiError loses its code across the action boundary in production.
// Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { printInvoice } from '@/features/billing/server/write.server';
import {
  getDiscountApproval, getPatient, getPatientRewards, getRegistrationDraft, listCatalogOptions, listCustomFieldDefinitions, listDiscountReasons, listFavouriteTests, listIcdCodes,
  listPaymentMethods, listRegistrationDrafts, previewRegistrationNumbers, searchCreditParties, searchDoctors, searchOrderables, searchPatients,
} from './read.server';
import {
  addFavouriteTest, approveDiscount, cancelOrder, changeOrderItems, createRegistration, createRegistrationDraft, deleteRegistrationDraft, quoteOrderItemsChange, quoteRegistration,
  recordPatientConsent, recordPayment, rejectDiscount, removeFavouriteTest, requestDiscountApproval, requestLabelPrints, resolveOrderFlag, updatePatient, uploadTrf,
} from './write.server';
import type {
  ActionResult, CodedSetEntry, Consents, CreditPartySummary, CustomFieldDefinition, DiscountApprovalIn, DoctorSummary, DraftRecord, DraftRecordSummary, IcdCode, InvoicePrintDoc,
  LabelReadiness, NumberPreview, OrderableSummary, PatientRewards, PatientSummary, Quote, RegisterBody, RegistrationDraft, RegistrationResult,
} from './types';

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
/** LD-310 / T0D-REGSCREEN-1: TRF on the registration screen, before the order exists; the returned id rides in F9 `trf_attachment_ids`. */
export async function uploadRegistrationTrfAction(centreId: string, form: FormData, key: string): Promise<ActionResult<{ id: string }>> {
  const file = form.get('file');
  if (!(file instanceof File)) return { ok: false, status: 400, code: 'common.validation_failed' };
  return run(async () => ({ id: (await uploadTrf(centreId, undefined, file, key)).id }));
}
// LD-310 / T0D-REGSCREEN-2 (T0B-REGAPI-1/2): registration screen extras.
export async function listIcdCodesAction(): Promise<ActionResult<IcdCode[]>> { return run(() => listIcdCodes()); }
export async function listCustomFieldDefinitionsAction(): Promise<ActionResult<CustomFieldDefinition[]>> { return run(() => listCustomFieldDefinitions()); }
export async function previewNumbersAction(centreId: string): Promise<ActionResult<NumberPreview>> { return run(() => previewRegistrationNumbers(centreId)); }
export async function getPatientRewardsAction(patientId: string): Promise<ActionResult<PatientRewards>> { return run(() => getPatientRewards(patientId)); }
export async function getPatientSummaryAction(patientId: string): Promise<ActionResult<PatientSummary>> {
  return run(async () => { const p = await getPatient(patientId); return { id: p.id, patient_code: p.patient_code, full_name: p.full_name, sex: p.sex, age_display: p.age_display, ...(p.phone_masked ? { phone_masked: p.phone_masked } : {}) }; });
}
export async function listDraftsAction(): Promise<ActionResult<DraftRecordSummary[]>> { return run(() => listRegistrationDrafts()); }
export async function getDraftAction(draftId: string): Promise<ActionResult<DraftRecord>> { return run(() => getRegistrationDraft(draftId)); }
export async function createDraftAction(centreId: string, payload: string, key: string): Promise<ActionResult<true>> { return run(async () => (await createRegistrationDraft(centreId, payload, key), true as const)); }
export async function deleteDraftAction(draftId: string): Promise<ActionResult<true>> { return run(async () => (await deleteRegistrationDraft(draftId), true as const)); }
export async function listFavouritesAction(): Promise<ActionResult<string[]>> { return run(() => listFavouriteTests()); }
export async function addFavouriteAction(orderableId: string, key: string): Promise<ActionResult<true>> { return run(async () => (await addFavouriteTest(orderableId, key), true as const)); }
export async function removeFavouriteAction(orderableId: string): Promise<ActionResult<true>> { return run(async () => (await removeFavouriteTest(orderableId), true as const)); }
/** Names for favourites: FavouriteTest carries only the id and searchOrderables needs `q`, so the C3 tests list is the only id -> name source
 * (panels are not in it). Best effort: any failure is "no names" (dispute T0D-REGSCREEN-2). */
export async function listTestNamesAction(): Promise<OrderableSummary[]> {
  try { return (await listCatalogOptions()).map((o) => ({ ...o, kind: 'test' as const })); } catch { return []; }
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
