'use server';
// Server actions for the registration page. Errors become { ok:false, code, title } because a thrown ApiError loses its code across the
// action boundary in production. Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { printInvoice } from '@/features/billing/server/write.server';
import { getDiscountApproval, listPaymentMethods, searchCreditParties, searchDoctors, searchOrderables, searchPatients } from './read.server';
import { createRegistration, quoteRegistration, requestDiscountApproval, requestLabelPrints } from './write.server';
import type { ActionResult, CodedSetEntry, CreditPartySummary, DiscountApprovalIn, DoctorSummary, InvoicePrintDoc, LabelReadiness, OrderableSummary, PatientSummary, Quote, RegisterBody, RegistrationDraft, RegistrationResult } from './types';

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

export async function searchPatientsAction(query: string): Promise<ActionResult<PatientSummary[]>> { return run(() => searchPatients(query)); }
export async function searchOrderablesAction(q: string): Promise<ActionResult<OrderableSummary[]>> { return run(() => searchOrderables(q)); }
export async function searchDoctorsAction(q: string): Promise<ActionResult<DoctorSummary[]>> { return run(() => searchDoctors(q)); }
export async function searchCreditPartiesAction(q: string): Promise<ActionResult<CreditPartySummary[]>> { return run(() => searchCreditParties(q)); }
export async function listPaymentMethodsAction(): Promise<ActionResult<CodedSetEntry[]>> { return run(() => listPaymentMethods()); }
export async function quoteRegistrationAction(draft: RegistrationDraft): Promise<ActionResult<Quote>> { return run(() => quoteRegistration(draft)); }
export async function createRegistrationAction(body: RegisterBody, key: string): Promise<ActionResult<RegistrationResult>> { return run(() => createRegistration(body, key)); }
export async function requestDiscountApprovalAction(b: DiscountApprovalIn, key: string): Promise<ActionResult<{ id: string }>> { return run(() => requestDiscountApproval(b, key)); }
export async function printInvoiceAction(invoiceId: string, reasonCode: string, key: string): Promise<ActionResult<InvoicePrintDoc>> { return run(() => printInvoice(invoiceId, reasonCode, key)); }
export async function requestLabelPrintsAction(orderId: string, key: string): Promise<ActionResult<LabelReadiness>> { return run(() => requestLabelPrints(orderId, key)); }
export async function getDiscountApprovalAction(id: string): Promise<ActionResult<{ id: string; status?: string; state?: string }>> { return run(() => getDiscountApproval(id)); }
