'use server';
// C5 T-29 server actions (BFF): #47 getLabSettings, #48 updateLabSettings, #49-#52 delta-check rules, #53 listLabCodedSet, #54 upsertLabCode (02-TRD §5.8).
// Errors become { ok:false, status, code, title } (a thrown ApiError loses its code across the action boundary). Ids / enums / keys are checked before any network call;
// the API re-checks every limit. The JWT stays on the server (REQ-SEC-068). If-Match is sent for #48 / #51 / #52 only; #54 sends none (the UI cannot know a tenant row's version).
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { CODED_SETS, type CatalogOption, type CodedSetName, type DeltaRule, type DeltaRuleBody, type LabCode, type LabCodeBody, type LabSettings, type LabSettingsUpdate, type ResultSignoff, type VerificationPolicy, type VerificationPolicyUpsert } from './config.types';
import { KEY_RE, UUID_RE, type ActionResult } from './types';

const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed', title: 'Validation failed' });
async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code, title: e.problem.title };
  }
}
const JSON_HEADERS = { 'content-type': 'application/json' };
const versionOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2_147_483_647;
const CODE_RE = /^[a-z0-9_]{1,64}$/;

// LD-194: 'use server' exports must be async function declarations.
export async function getLabSettingsAction(): Promise<ActionResult<LabSettings>> {
  return run(() => serverFetch<LabSettings>('/v1/lab/settings'));
}

export async function updateLabSettingsAction(version: number, body: LabSettingsUpdate): Promise<ActionResult<LabSettings>> {
  if (!versionOk(version)) return bad();
  return run(() => serverFetch<LabSettings>('/v1/lab/settings', { method: 'PUT', headers: { ...JSON_HEADERS, 'if-match': `"${version}"` }, body: JSON.stringify(body) }));
}

export async function listDeltaRulesAction(): Promise<ActionResult<DeltaRule[]>> {
  return run(async () => (await serverFetch<{ data: DeltaRule[] }>('/v1/lab/delta-check-rules')).data);
}

export async function createDeltaRuleAction(body: DeltaRuleBody, key: string): Promise<ActionResult<DeltaRule>> {
  if (!KEY_RE.test(key) || typeof body?.analyte_id !== 'string' || !UUID_RE.test(body.analyte_id)) return bad();
  return run(() => serverFetch<DeltaRule>('/v1/lab/delta-check-rules', { method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': key }, body: JSON.stringify(body) }));
}

export async function versionDeltaRuleAction(id: string, version: number, body: DeltaRuleBody, key: string): Promise<ActionResult<DeltaRule>> {
  if (!KEY_RE.test(key) || !UUID_RE.test(id) || !versionOk(version) || 'analyte_id' in body) return bad();
  return run(() => serverFetch<DeltaRule>(`/v1/lab/delta-check-rules/${id}/versions`, {
    method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': key, 'if-match': `"${version}"` }, body: JSON.stringify(body),
  }));
}

export async function deactivateDeltaRuleAction(id: string, version: number): Promise<ActionResult<DeltaRule>> {
  if (!UUID_RE.test(id) || !versionOk(version)) return bad();
  return run(() => serverFetch<DeltaRule>(`/v1/lab/delta-check-rules/${id}/deactivate`, { method: 'POST', headers: { ...JSON_HEADERS, 'if-match': `"${version}"` }, body: '{}' }));
}

export async function listCodedSetAction(set: CodedSetName): Promise<ActionResult<LabCode[]>> {
  if (!CODED_SETS.includes(set)) return bad();
  return run(async () => (await serverFetch<{ data: LabCode[] }>(`/v1/lab/coded-sets/${set}`)).data);
}

export async function upsertCodeAction(set: CodedSetName, code: string, body: LabCodeBody): Promise<ActionResult<LabCode>> {
  if (!CODED_SETS.includes(set) || !CODE_RE.test(code)) return bad();
  return run(() => serverFetch<LabCode>(`/v1/lab/coded-sets/${set}/codes/${code}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) }));
}

// T0D-VERLEVEL-1 (LD-316): listVerificationPolicies, upsertVerificationPolicy (If-Match only when the target already has an active policy), getResultSignoffs (lab.yaml)
// and the two catalog option reads the scope picker needs (catalog.yaml listDepartments / listTests). The API re-checks lab.verification_policy.manage and aal2.

export async function listVerificationPoliciesAction(): Promise<ActionResult<VerificationPolicy[]>> {
  return run(async () => (await serverFetch<{ data: VerificationPolicy[] }>('/v1/lab/verification-policies')).data);
}

/** version = the active policy of this target (If-Match), undefined = a new target (no If-Match, TRD §3.2). The body carries exactly the id its scope needs. */
export async function upsertVerificationPolicyAction(body: VerificationPolicyUpsert, version?: number): Promise<ActionResult<VerificationPolicy>> {
  const { scope, required_verifiers: n, require_pathologist: p, allow_enterer_verify: e } = body ?? ({} as VerificationPolicyUpsert);
  if (![1, 2, 3].includes(n) || typeof p !== 'boolean' || typeof e !== 'boolean' || (version !== undefined && !versionOk(version))) return bad();
  const target = scope === 'lab' ? {} : scope === 'department' && UUID_RE.test(body.department_id ?? '') ? { department_id: body.department_id } : scope === 'test' && UUID_RE.test(body.test_id ?? '') ? { test_id: body.test_id } : null;
  if (!target) return bad();
  return run(() => serverFetch<VerificationPolicy>('/v1/lab/verification-policies', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(version !== undefined ? { 'if-match': `"${version}"` } : {}) },
    body: JSON.stringify({ scope, ...target, required_verifiers: n, require_pathologist: p, allow_enterer_verify: e }),
  }));
}

export async function getResultSignoffsAction(resultId: string): Promise<ActionResult<ResultSignoff[]>> {
  if (!UUID_RE.test(resultId)) return bad();
  return run(async () => (await serverFetch<{ data: ResultSignoff[] }>(`/v1/lab/results/${resultId}/signoffs`)).data);
}

// ponytail: first page only (limit 200, the contract maximum); page through the cursor if a lab ever has more departments or tests.
export async function listDepartmentOptionsAction(): Promise<ActionResult<CatalogOption[]>> {
  return run(async () => (await serverFetch<{ data: CatalogOption[] }>('/v1/catalog/departments?is_active=true&limit=200')).data);
}
export async function listTestOptionsAction(): Promise<ActionResult<CatalogOption[]>> {
  return run(async () => (await serverFetch<{ data: CatalogOption[] }>('/v1/catalog/tests?limit=200')).data);
}
