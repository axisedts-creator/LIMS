import 'server-only';
// C11 T-21 BFF for the Report tab: R1-R10 (report draft, sign-out, change, versions, addenda), K13/K14 (published synoptic templates), the C5 amendment reasons and the diagnosis search.
// Every id is validated (REQ-SEC-026/027); bodies are rebuilt field by field (no mass assignment); row versions go in If-Match; required idempotency keys are forwarded
// (PUT report-draft has none: x-idempotency none). The bearer JWT never reaches client code (REQ-SEC-068). LD-140 (2026-11-13): no UI in this file.
import { serverFetch } from '@/core/api/server-fetch';
import { getSettings, getSynoptic } from './config.server';
import { bad, idemKey, ifMatch, jsonInit, uuid, version } from './shared';
import type { AddendumInput, Addendum, ChangeInput, DiagnosisOption, ReasonOption, ReportDraft, ReportDraftInput, SignOutResult, SynopticSummary, SynopticValue, VersionFull, VersionSummary } from './report.types';
import type { CaseKind } from './types';

const API = '/v1/anatomic';
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const KINDS = ['ihc', 'special_stain', 'molecular', 'other'] as const;
/** C5 system codes (08 A17 D-62): never offered as a manual change reason. */
const SYSTEM_REASONS: readonly string[] = ['module_phase_progression', 'module_preliminary_update', 'supplementary_report'];

const str = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad();
  return v;
};
const list = <T>(v: unknown, max: number, f: (x: unknown) => T): T[] => {
  if (!Array.isArray(v) || v.length > max) throw bad();
  return v.map(f);
};
const guard = (v: number, key: string) => ({ 'if-match': ifMatch(v), 'idempotency-key': idemKey(key) });

/** One synoptic value: string ≤ 4000 | finite number | boolean | string[] ≤ 100 (TRD §4.5.2). */
const value = (v: unknown): SynopticValue => {
  if (typeof v === 'string') return str(v, 0, 4000);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  return list(v, 100, (x) => str(x, 0, 4000));
};
const values = (v: unknown): Record<string, SynopticValue> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad();
  const e = Object.entries(v);
  if (e.length > 300) throw bad();
  return Object.fromEntries(e.map(([k, x]) => [str(k, 1, 64), value(x)]));
};

/** getAnatomicReportDraft (R1): 404 = no draft yet (the caller shows the empty state). */
export const getDraft = (caseId: string) => serverFetch<ReportDraft>(`${API}/cases/${uuid(caseId)}/report-draft`);

/** saveAnatomicReportDraft (R2): full replace; If-Match "0" creates. No Idempotency-Key. */
export function saveDraft(caseId: string, v: number, input: ReportDraftInput) {
  if (typeof input.is_critical !== 'boolean' || (input.flag !== undefined && input.flag !== 'N' && input.flag !== 'A')) throw bad();
  const body = {
    gross_text: str(input.gross_text, 0, 20000),
    microscopy_text: str(input.microscopy_text, 0, 20000),
    impression_text: str(input.impression_text, 0, 8000),
    comment_text: str(input.comment_text, 0, 8000),
    ...(input.flag ? { flag: input.flag } : {}),
    is_critical: input.is_critical,
    synoptic: list(input.synoptic, 5, (s) => {
      const o = s as ReportDraftInput['synoptic'][number];
      return { template_id: uuid(o?.template_id), values: values(o?.values) };
    }),
    image_ids: list(input.image_ids, 24, uuid),
    ancillary: list(input.ancillary, 50, (a) => {
      const o = a as ReportDraftInput['ancillary'][number];
      return { stain_order_id: uuid(o?.stain_order_id), result_text: str(o?.result_text, 1, 2000) };
    }),
    diagnosis_codes: list(input.diagnosis_codes, 20, (c) => {
      const code = str((c as { code?: unknown })?.code, 1, 64);
      if (!CODE.test(code)) throw bad();
      return { code };
    }),
  };
  return serverFetch<ReportDraft>(`${API}/cases/${uuid(caseId)}/report-draft`, jsonInit('PUT', body, { 'if-match': ifMatch(v) }));
}

/** signOutAnatomicCase (R3): If-Match = the DRAFT version. */
export const signOut = (caseId: string, draftVersion: number, key: string) =>
  serverFetch<SignOutResult>(`${API}/cases/${uuid(caseId)}/sign-out`, jsonInit('POST', { attest: true }, guard(draftVersion, key)));

/** startAnatomicCaseChange (R4): If-Match = the CASE version. */
export function startChange(caseId: string, caseVersion: number, input: ChangeInput, key: string) {
  const code = str(input.reason_code, 1, 64);
  if (!CODE.test(code)) throw bad();
  const text = input.reason_text === undefined ? undefined : str(input.reason_text, 0, 500);
  return serverFetch<ReportDraft>(`${API}/cases/${uuid(caseId)}/changes`, jsonInit('POST', { reason_code: code, ...(text ? { reason_text: text } : {}) }, guard(caseVersion, key)));
}

/** discardAnatomicChange (R5): If-Match = the draft version. */
export const discardChange = (caseId: string, draftVersion: number, key: string) =>
  serverFetch<unknown>(`${API}/cases/${uuid(caseId)}/changes/discard`, jsonInit('POST', {}, guard(draftVersion, key))); // contract: requestBody required ({})

/** listAnatomicReportVersions (R6) / getAnatomicReportVersion (R7). */
export const listVersions = async (caseId: string) => (await serverFetch<{ data: VersionSummary[] }>(`${API}/cases/${uuid(caseId)}/versions`)).data;
export function getVersion(caseId: string, n: number) {
  if (version(n) < 1) throw bad();
  return serverFetch<VersionFull>(`${API}/cases/${uuid(caseId)}/versions/${n}`);
}

const addendumBody = (input: AddendumInput) => {
  if (!KINDS.includes(input.kind)) throw bad();
  return {
    kind: input.kind,
    text: str(input.text, 1, 8000),
    stain_order_ids: list(input.stain_order_ids, 20, uuid),
    ...(input.addon_case_item_id ? { addon_case_item_id: uuid(input.addon_case_item_id) } : {}),
  };
};
/** createAnatomicAddendum (R8). */
export const createAddendum = (caseId: string, input: AddendumInput, key: string) =>
  serverFetch<Addendum>(`${API}/cases/${uuid(caseId)}/addenda`, jsonInit('POST', addendumBody(input), { 'idempotency-key': idemKey(key) }));
/** updateAnatomicAddendum (R9). */
export const updateAddendum = (id: string, v: number, input: AddendumInput) =>
  serverFetch<Addendum>(`${API}/addenda/${uuid(id)}`, jsonInit('PUT', addendumBody(input), { 'if-match': ifMatch(v) }));
/** signAnatomicAddendum (R10). */
export const signAddendum = (id: string, v: number, key: string) =>
  serverFetch<SignOutResult>(`${API}/addenda/${uuid(id)}/sign`, jsonInit('POST', { attest: true }, guard(v, key)));

/** listAnatomicSynopticTemplates (K13): published templates for the case kind. */
export async function listPublishedSynoptic(kind: CaseKind) {
  if (!['histology', 'cytology', 'ihc', 'molecular'].includes(kind)) throw bad();
  return (await serverFetch<{ data: SynopticSummary[] }>(`${API}/synoptic-templates?${new URLSearchParams({ status: 'published', case_kind: kind })}`)).data;
}
/** getAnatomicSynopticTemplate (K14): the definition of ONE template version (a saved instance keeps its own version). */
export const getTemplate = (id: string) => getSynoptic(id);

/** C5 listLabCodedSet (04-UI-UX §4.2.7): active reasons in sort order, system codes removed. */
export async function listAmendmentReasons(): Promise<ReasonOption[]> {
  const r = await serverFetch<{ data: { code: string; display: string; sort_order?: number; is_active?: boolean }[] }>('/v1/lab/coded-sets/amendment_reasons');
  return r.data
    .filter((c) => c.is_active !== false && !SYSTEM_REASONS.includes(c.code))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(({ code, display }) => ({ code, display }));
}

/** K11 diagnoses search: `q` only (no patient or case data in the URL, REQ-SEC-098). */
export async function searchDiagnoses(q: string): Promise<DiagnosisOption[]> {
  const p = new URLSearchParams({ q: q.slice(0, 60), limit: '20' });
  const r = await serverFetch<{ data: { code: string; display: string; system: string; is_active?: boolean }[] }>(`${API}/coded-sets/diagnoses/values?${p}`);
  return r.data.filter((c) => c.is_active !== false).map(({ code, display, system }) => ({ code, display, system }));
}

/** getAnatomicSettings: only max_report_images is read here. */
export const getMaxReportImages = async () => (await getSettings()).max_report_images;
