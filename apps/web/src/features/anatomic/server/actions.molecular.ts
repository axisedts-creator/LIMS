'use server';
// Server actions for the T-22 client components (Molecular tab, batch screens). ApiError becomes { ok:false, status, code } data; the bearer JWT never reaches
// client code (REQ-SEC-068). The accession number of a scan goes through lookupObjectAction (POST body only, REQ-SEC-098). LD-140 (2026-11-13): no UI here.
import 'server-only';
import { addBatchMembers, closeBatch, createBatch, listAssays, listBatches, removeBatchMembers, saveMolecularResults } from './molecular.server';
import { run } from './shared';
import type { ActionResult, Assay, Batch, BatchDetail, BatchInput, MolecularInput, MolecularResult } from './types';

export async function listAssaysAction(): Promise<ActionResult<Assay[]>> {
  return run(() => listAssays());
}
/** Up to 200 batches for the Molecular tab's Batch picker (filtered per assay in the browser). */
export async function listBatchesAction(): Promise<ActionResult<Batch[]>> {
  return run(async () => (await listBatches({}, 200)).data);
}
export async function saveMolecularResultsAction(caseId: string, rev: number, results: MolecularInput[]): Promise<ActionResult<{ molecular_rev: number; results: MolecularResult[] }>> {
  return run(() => saveMolecularResults(caseId, rev, results));
}
export async function createBatchAction(input: BatchInput, key: string): Promise<ActionResult<Batch>> {
  return run(() => createBatch(input, key));
}
export async function addBatchMembersAction(batchId: string, members: { case_id: string; position: number }[], key: string): Promise<ActionResult<BatchDetail>> {
  return run(() => addBatchMembers(batchId, members, key));
}
export async function removeBatchMembersAction(batchId: string, version: number, caseIds: string[], key: string): Promise<ActionResult<BatchDetail>> {
  return run(() => removeBatchMembers(batchId, version, caseIds, key));
}
export async function closeBatchAction(batchId: string, version: number, key: string): Promise<ActionResult<BatchDetail>> {
  return run(() => closeBatch(batchId, version, key));
}
