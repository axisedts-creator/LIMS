'use server';
// Server actions for the T-20 client components (material, stains, images, tracking, movement dialog). Same shape as actions.ts: ApiError becomes
// { ok:false, status, code } data; the bearer JWT never reaches client code (REQ-SEC-068). LD-140 (2026-11-13): no UI here.
import 'server-only';
import { getCase, listAdequacy, listMovements, listStains, lookupLabel } from './reads.server';
import { run } from './shared';
import {
  addBlocks, addSlides, cancelStain, completeStain, deactivateImage, linkAddon, markSlidesReady, orderStain, recordMovements, saveAssessment, startStain, updateImage, uploadImage,
} from './writes.material.server';
import type {
  AddBlocksInput, AddSlidesInput, ActionResult, AssessmentInput, Block, BulkResult, CaseDetail, CaseImage, CodedValue, CompleteStainInput, ImageMetaInput, LookupResult, Movement,
  MovementInput, MovementOutcome, OrderStainInput, Slide, Stain, StainOrder,
} from './types';

export async function listStainsAction(): Promise<ActionResult<Stain[]>> {
  return run(() => listStains());
}
export async function listAdequacyAction(): Promise<ActionResult<CodedValue[]>> {
  return run(() => listAdequacy());
}
export async function addBlocksAction(caseId: string, input: AddBlocksInput, key: string): Promise<ActionResult<{ blocks: Block[] }>> {
  return run(() => addBlocks(caseId, input, key));
}
export async function addSlidesAction(caseId: string, input: AddSlidesInput, key: string): Promise<ActionResult<{ slides: Slide[] }>> {
  return run(() => addSlides(caseId, input, key));
}
export async function markSlidesReadyAction(ids: string[], key: string): Promise<ActionResult<{ results: BulkResult[] }>> {
  return run(() => markSlidesReady(ids, key));
}
export async function saveAssessmentAction(slideId: string, version: number, input: AssessmentInput): Promise<ActionResult<Slide>> {
  return run(() => saveAssessment(slideId, version, input));
}
export async function orderStainAction(caseId: string, input: OrderStainInput, key: string): Promise<ActionResult<StainOrder>> {
  return run(() => orderStain(caseId, input, key));
}
export async function startStainAction(id: string, version: number, key: string): Promise<ActionResult<StainOrder>> {
  return run(() => startStain(id, version, key));
}
export async function completeStainAction(id: string, version: number, input: CompleteStainInput, key: string): Promise<ActionResult<{ stain_order: StainOrder; slides: Slide[] }>> {
  return run(() => completeStain(id, version, input, key));
}
export async function cancelStainAction(id: string, version: number, reason: string, key: string): Promise<ActionResult<StainOrder>> {
  return run(() => cancelStain(id, version, reason, key));
}
export async function linkAddonAction(id: string, version: number, orderItemId: string, key: string): Promise<ActionResult<StainOrder>> {
  return run(() => linkAddon(id, version, orderItemId, key));
}
export async function recordMovementsAction(input: MovementInput, key: string): Promise<ActionResult<{ results: MovementOutcome[] }>> {
  return run(() => recordMovements(input, key));
}
export async function uploadImageAction(caseId: string, form: FormData, key: string): Promise<ActionResult<CaseImage>> {
  return run(() => uploadImage(caseId, form, key));
}
export async function updateImageAction(imageId: string, version: number, input: ImageMetaInput): Promise<ActionResult<CaseImage>> {
  return run(() => updateImage(imageId, version, input));
}
export async function deactivateImageAction(imageId: string, version: number, key: string): Promise<ActionResult<CaseImage>> {
  return run(() => deactivateImage(imageId, version, key));
}

// ---- tracking (single lookup + basket): the label travels in a POST body only (REQ-SEC-098)
export async function lookupObjectAction(label: string): Promise<ActionResult<LookupResult>> {
  return run(() => lookupLabel(label));
}
export async function getCaseForTrackingAction(caseId: string): Promise<ActionResult<CaseDetail>> {
  return run(() => getCase(caseId));
}
export async function listMovementsAction(kind: 'block' | 'slide', id: string): Promise<ActionResult<Movement[]>> {
  return run(() => listMovements(kind, id));
}
