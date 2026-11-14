'use server';
// Server actions for the billing client components. Errors become { ok:false, code } because a thrown ApiError loses its code across
// the action boundary in production. Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { approveRefund, cancelInvoice, closeCashSession, createBillingExport, getBillingExport, issuePartialCreditNote, printInvoice, rejectRefund, requestRefund, resolveFinanceReviewItem, retryCbmsDocument, updateBillingSettings } from './write.server';
import type { ActionResult, BillingSettings, ExportFormat, ExportJob, ExportKind, InvoicePrintDocument } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

export async function printInvoiceAction(invoiceId: string, reasonCode: string, key: string): Promise<ActionResult<{ print_no: number; copy_mark?: string; document: InvoicePrintDocument }>> {
  return run(() => printInvoice(invoiceId, reasonCode, key));
}
export async function cancelInvoiceAction(invoiceId: string, version: number, r: { reason_code: string; reason_text?: string }, key: string): Promise<ActionResult<{ credit_note_no: string }>> {
  return run(async () => ({ credit_note_no: (await cancelInvoice(invoiceId, version, r, key)).credit_note.credit_note_no }));
}
export async function issuePartialCreditNoteAction(invoiceId: string, r: { lines: { invoice_line_id: string; amount_paisa?: number }[]; reason_code: string; reason_text?: string }, key: string): Promise<ActionResult<{ credit_note_no: string }>> {
  return run(async () => ({ credit_note_no: (await issuePartialCreditNote(invoiceId, r, key)).credit_note_no }));
}
export async function requestRefundAction(orderId: string, r: { method_code: string; refund_amount_paisa: number; reason_code: string; reason_text?: string }, key: string): Promise<ActionResult<{ id: string }>> {
  return run(async () => ({ id: (await requestRefund(orderId, r, key)).id }));
}
export async function approveRefundAction(id: string, version: number, key: string): Promise<ActionResult<true>> {
  return run(async () => (await approveRefund(id, version, key), true as const));
}
export async function rejectRefundAction(id: string, version: number, note: string, key: string): Promise<ActionResult<true>> {
  return run(async () => (await rejectRefund(id, version, note, key), true as const));
}
export async function resolveFinanceReviewItemAction(id: string, version: number, r: { resolution_code: 'refunded' | 'kept_as_advance' | 'other'; note?: string }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await resolveFinanceReviewItem(id, version, r, key), true as const));
}
export async function closeCashSessionAction(id: string, version: number, r: { counted: { method_code: string; amount_paisa: number }[]; note?: string }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await closeCashSession(id, version, r, key), true as const));
}
export async function retryCbmsAction(kind: string, id: string, key: string): Promise<ActionResult<{ cbms_state: string }>> {
  return run(() => retryCbmsDocument(kind, id, key));
}
export async function createExportAction(kind: ExportKind, format: ExportFormat, filters: { fiscal_year_bs?: string; from?: string; to?: string; centre_id?: string }, key: string): Promise<ActionResult<Pick<ExportJob, 'id' | 'status'>>> {
  return run(async () => {
    const j = await createBillingExport(kind, format, filters, key);
    return { id: j.id, status: j.status };
  });
}
export async function getExportAction(exportId: string): Promise<ActionResult<Pick<ExportJob, 'id' | 'status'>>> {
  return run(async () => {
    const j = await getBillingExport(exportId);
    return { id: j.id, status: j.status };
  });
}
export async function updateBillingSettingsAction(version: number, s: Omit<BillingSettings, 'version'>, key: string): Promise<ActionResult<{ version: number | undefined }>> {
  return run(async () => ({ version: (await updateBillingSettings(version, s, key)).version }));
}
