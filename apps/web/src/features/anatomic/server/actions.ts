'use server';
// Server actions for the T-19 client components. A thrown ApiError loses its code across the action boundary in production, so errors become
// { ok:false, status, code } (same as micro/catalog actions). The bearer JWT never reaches client code (REQ-SEC-068). LD-140: no UI here.
import 'server-only';
import { listAssignees, listCancelReasons, lookupLabel } from './reads.server';
import { run } from './shared';
import { accessionCase, addPart, cancelCase, saveGross, transitionCase, updatePart, uploadGrossImage } from './writes.server';
import type { AccessionInput, ActionResult, Assignee, CancelInput, CaseDetail, CodedValue, GrossInput, GrossRecord, LookupResult, Part, PartInput, TransitionOp } from './types';

export async function lookupLabelAction(label: string): Promise<ActionResult<LookupResult>> {
  return run(() => lookupLabel(label));
}
export async function listAssigneesAction(caseId: string, q: string): Promise<ActionResult<Assignee[]>> {
  return run(() => listAssignees(caseId, q));
}
export async function listCancelReasonsAction(): Promise<ActionResult<CodedValue[]>> {
  return run(() => listCancelReasons());
}
export async function transitionCaseAction(caseId: string, op: TransitionOp, version: number, key: string): Promise<ActionResult<CaseDetail>> {
  return run(() => transitionCase(caseId, op, version, key));
}
export async function cancelCaseAction(caseId: string, version: number, input: CancelInput, key: string): Promise<ActionResult<CaseDetail>> {
  return run(() => cancelCase(caseId, version, input, key));
}
export async function accessionCaseAction(caseId: string, version: number, input: AccessionInput, key: string): Promise<ActionResult<CaseDetail>> {
  return run(() => accessionCase(caseId, version, input, key));
}
export async function addPartAction(caseId: string, input: PartInput, key: string): Promise<ActionResult<Part>> {
  return run(() => addPart(caseId, input, key));
}
export async function updatePartAction(caseId: string, partId: string, version: number, input: PartInput): Promise<ActionResult<Part>> {
  return run(() => updatePart(caseId, partId, version, input));
}
export async function saveGrossAction(caseId: string, partId: string, version: number, input: GrossInput): Promise<ActionResult<GrossRecord>> {
  return run(() => saveGross(caseId, partId, version, input));
}
export async function uploadGrossImageAction(caseId: string, form: FormData, key: string): Promise<ActionResult<{ id: string }>> {
  return run(() => uploadGrossImage(caseId, form, key));
}
