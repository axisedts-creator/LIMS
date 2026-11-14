'use server';
// Server actions for the T-21 Report tab. Same shape as actions.ts: ApiError becomes { ok:false, status, code, errors? } data; the bearer JWT never reaches client code (REQ-SEC-068).
// LD-140 (2026-11-13): no UI here.
import 'server-only';
import {
  createAddendum, discardChange, getDraft, getMaxReportImages, getTemplate, getVersion, listAmendmentReasons, listPublishedSynoptic, listVersions, saveDraft, searchDiagnoses, signAddendum, signOut,
  startChange, updateAddendum,
} from './report.server';
import { run } from './shared';
import type { SynopticTemplate } from './config.types';
import type {
  Addendum, AddendumInput, ChangeInput, DiagnosisOption, ReasonOption, ReportDraft, ReportDraftInput, SignOutResult, SynopticSummary, VersionFull, VersionSummary,
} from './report.types';
import type { ActionResult, CaseKind } from './types';

export async function getReportDraftAction(caseId: string): Promise<ActionResult<ReportDraft>> {
  return run(() => getDraft(caseId));
}
export async function saveReportDraftAction(caseId: string, version: number, input: ReportDraftInput): Promise<ActionResult<ReportDraft>> {
  return run(() => saveDraft(caseId, version, input));
}
export async function signOutAction(caseId: string, draftVersion: number, key: string): Promise<ActionResult<SignOutResult>> {
  return run(() => signOut(caseId, draftVersion, key));
}
export async function startChangeAction(caseId: string, caseVersion: number, input: ChangeInput, key: string): Promise<ActionResult<ReportDraft>> {
  return run(() => startChange(caseId, caseVersion, input, key));
}
export async function discardChangeAction(caseId: string, draftVersion: number, key: string): Promise<ActionResult<unknown>> {
  return run(() => discardChange(caseId, draftVersion, key));
}
export async function listVersionsAction(caseId: string): Promise<ActionResult<VersionSummary[]>> {
  return run(() => listVersions(caseId));
}
export async function getVersionAction(caseId: string, n: number): Promise<ActionResult<VersionFull>> {
  return run(() => getVersion(caseId, n));
}
export async function createAddendumAction(caseId: string, input: AddendumInput, key: string): Promise<ActionResult<Addendum>> {
  return run(() => createAddendum(caseId, input, key));
}
export async function updateAddendumAction(id: string, version: number, input: AddendumInput): Promise<ActionResult<Addendum>> {
  return run(() => updateAddendum(id, version, input));
}
export async function signAddendumAction(id: string, version: number, key: string): Promise<ActionResult<SignOutResult>> {
  return run(() => signAddendum(id, version, key));
}
export async function listPublishedSynopticAction(kind: CaseKind): Promise<ActionResult<SynopticSummary[]>> {
  return run(() => listPublishedSynoptic(kind));
}
export async function getSynopticTemplateAction(id: string): Promise<ActionResult<SynopticTemplate>> {
  return run(() => getTemplate(id));
}
export async function listAmendmentReasonsAction(): Promise<ActionResult<ReasonOption[]>> {
  return run(() => listAmendmentReasons());
}
export async function searchDiagnosesAction(q: string): Promise<ActionResult<DiagnosisOption[]>> {
  return run(() => searchDiagnoses(q));
}
export async function getMaxReportImagesAction(): Promise<ActionResult<number>> {
  return run(() => getMaxReportImages());
}
