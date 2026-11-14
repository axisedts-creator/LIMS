'use server';
// Server actions for the catalog client components (SCR-02…05 master editors, test/analyte/range editors). A thrown ApiError loses
// its code across the action boundary in production, so errors become { ok:false, status, code, errors? } (errors[] = per-field
// problem details for the form to place). Only ApiError is mapped; anything else rethrows. Master `kind` is checked against the
// table below, so a tampered value reaches nothing.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createAnalyte, type CreateAnalyteInput } from './createAnalyte.server';
import { createAnalyteVersionDraft } from './createAnalyteVersionDraft.server';
import { createContainer } from './createContainer.server';
import { createDepartment } from './createDepartment.server';
import { createMethod } from './createMethod.server';
import { createCriticalLimitSetDraft, createReferenceRangeSetDraft } from './createRangeSetDraft.server';
import { createSpecimenType } from './createSpecimenType.server';
import { createUnit } from './createUnit.server';
import { createValueSet } from './createValueSet.server';
import { discardCriticalLimitSetDraft, discardReferenceRangeSetDraft } from './discardRangeSet.server';
import { previewReferenceRange } from './previewReferenceRange.server';
import { publishAnalyteVersion } from './publishAnalyteVersion.server';
import { publishCriticalLimitSet, publishReferenceRangeSet } from './publishRangeSet.server';
import { replaceCriticalLimitBands, replaceReferenceRangeBands } from './replaceBands.server';
import { retireCriticalLimitSet, retireReferenceRangeSet } from './retireRangeSet.server';
import { bad } from './shared';
import type { ActionResult, AnalyteRow, AnalyteVersion, Band, FieldError, FormulaInput, FormulaValidation, PreviewInput, PreviewResult, PublishBody, RangeKind, RangeSet, TestDto } from './types';
import { updateAnalyte } from './updateAnalyte.server';
import { updateAnalyteVersionDraft } from './updateAnalyteVersionDraft.server';
import { updateContainer } from './updateContainer.server';
import { updateDepartment } from './updateDepartment.server';
import { updateMethod } from './updateMethod.server';
import { updateSpecimenType } from './updateSpecimenType.server';
import { updateTest } from './updateTest.server';
import { updateUnit } from './updateUnit.server';
import { updateValueSet } from './updateValueSet.server';
import { validateFormula } from './validateFormula.server';

type Saved = { id: string; version: number };
const OPS: Record<string, { create: (i: unknown, k?: string) => Promise<Saved>; update: (id: string, v: number, i: unknown) => Promise<Saved> }> = {
  department: { create: createDepartment, update: updateDepartment },
  specimen_type: { create: createSpecimenType, update: updateSpecimenType },
  container: { create: createContainer, update: updateContainer },
  method: { create: createMethod, update: updateMethod },
  unit: { create: createUnit, update: updateUnit },
  value_set: { create: createValueSet, update: updateValueSet },
};
export type MasterKind = 'department' | 'specimen_type' | 'container' | 'method' | 'unit' | 'value_set';

const op = (kind: string) => {
  const o = Object.hasOwn(OPS, kind) ? OPS[kind] : undefined;
  if (!o) throw bad();
  return o;
};

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const errors = e.problem['errors'];
      return { ok: false, status: e.status, code: e.problem.code, ...(Array.isArray(errors) ? { errors: errors as FieldError[] } : {}) };
    }
    throw e;
  }
}
const saved = async (f: () => Promise<Saved>): Promise<Saved> => { const r = await f(); return { id: r.id, version: r.version }; };

export async function createMasterAction(kind: MasterKind, input: unknown, idempotencyKey: string): Promise<ActionResult<Saved>> {
  return run(() => saved(() => op(kind).create(input, idempotencyKey)));
}

export async function updateMasterAction(kind: MasterKind, id: string, version: number, input: unknown): Promise<ActionResult<Saved>> {
  return run(() => saved(() => op(kind).update(id, version, input)));
}

export async function updateTestAction(testId: string, version: number, fields: Parameters<typeof updateTest>[2]): Promise<ActionResult<TestDto>> {
  return run(() => updateTest(testId, version, fields));
}
export async function createAnalyteAction(testId: string, input: CreateAnalyteInput, idempotencyKey: string): Promise<ActionResult<{ id: string; code: string; draft_version_id?: string }>> {
  return run(() => createAnalyte(testId, input, idempotencyKey));
}
export async function updateAnalyteAction(analyteId: string, version: number, fields: Parameters<typeof updateAnalyte>[2]): Promise<ActionResult<AnalyteRow>> {
  return run(() => updateAnalyte(analyteId, version, fields));
}
export async function createAnalyteVersionDraftAction(analyteId: string, idempotencyKey: string): Promise<ActionResult<AnalyteVersion>> {
  return run(() => createAnalyteVersionDraft(analyteId, idempotencyKey));
}
export async function updateAnalyteVersionDraftAction(versionId: string, version: number, fields: Parameters<typeof updateAnalyteVersionDraft>[2]): Promise<ActionResult<AnalyteVersion>> {
  return run(() => updateAnalyteVersionDraft(versionId, version, fields));
}
export async function publishAnalyteVersionAction(versionId: string, version: number, body: PublishBody, idempotencyKey: string): Promise<ActionResult<AnalyteVersion>> {
  return run(() => publishAnalyteVersion(versionId, version, body, idempotencyKey));
}
export async function validateFormulaAction(input: FormulaInput): Promise<ActionResult<FormulaValidation>> {
  return run(() => validateFormula(input));
}
export async function previewReferenceRangeAction(input: PreviewInput): Promise<ActionResult<PreviewResult>> {
  return run(() => previewReferenceRange(input));
}

// SCR-08: one entry point per operation, the range/critical flavour picked by `kind`.
export async function createRangeSetDraftAction(kind: RangeKind, analyteId: string, body: { copy_from_set_id?: string; bands?: Band[] }, idempotencyKey: string): Promise<ActionResult<RangeSet>> {
  return run(() => (kind === 'ranges' ? createReferenceRangeSetDraft : createCriticalLimitSetDraft)(analyteId, body, idempotencyKey));
}
export async function replaceBandsAction(kind: RangeKind, setId: string, version: number, bands: Band[]): Promise<ActionResult<RangeSet>> {
  return run(() => (kind === 'ranges' ? replaceReferenceRangeBands : replaceCriticalLimitBands)(setId, version, bands));
}
export async function publishRangeSetAction(kind: RangeKind, setId: string, version: number, body: { effective_from?: string; change_reason: string }, idempotencyKey: string): Promise<ActionResult<RangeSet>> {
  return run(() => (kind === 'ranges' ? publishReferenceRangeSet : publishCriticalLimitSet)(setId, version, body, idempotencyKey));
}
export async function retireRangeSetAction(kind: RangeKind, setId: string, version: number, body: { change_reason: string; effective_at?: string }, idempotencyKey: string): Promise<ActionResult<RangeSet>> {
  return run(() => (kind === 'ranges' ? retireReferenceRangeSet : retireCriticalLimitSet)(setId, version, body, idempotencyKey));
}
export async function discardRangeSetAction(kind: RangeKind, setId: string, version: number): Promise<ActionResult<RangeSet>> {
  return run(() => (kind === 'ranges' ? discardReferenceRangeSetDraft : discardCriticalLimitSetDraft)(setId, version));
}
