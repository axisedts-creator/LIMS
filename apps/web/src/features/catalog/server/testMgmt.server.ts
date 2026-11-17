import 'server-only';
// T0D-TESTMGMT-1 (LD-318): typed BFF calls for the test management screens. contracts/openapi/catalog.yaml after T0C-TESTMGMT-1:
// TestCreate / TestUpdate (parity fields), TatTargetsSet.stage_targets, AnalyteCreate / AnalyteUpdate / AnalyteVersionDraftUpdate,
// TestCategory*, CommentCodeCreate. New file on purpose: rs-c3 pins the existing server files byte for byte.
// Every body goes through `pick` (only declared fields, each validated), so a tampered client value never reaches the API.
import { serverFetch } from '@/core/api/server-fetch';
import { idemKey, ifMatch, json, uuid as pathId } from './guard';
import { getTest } from './getTest.server';
import { listAllTests } from './listTests.server';
import { bad, bool, exactCode, int, list, oneOf, pick, str, upperCode, uuid, type V } from './shared';
import { COMMENT_CODE_RE, UUID_RE } from './types';

export const WORKFLOWS = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'] as const;
export const REPORT_TYPES = ['four_column', 'three_column', 'two_column', 'graph', 'template_based_html', 'micro_automated', 'cbc_four_column', 'micro_manual', 'histo', 'four_column_10_font'] as const;
export const PROCESSING_TYPES = ['local', 'branch_transfer', 'outsource_branch'] as const;
export const STAGES = ['registration', 'sample_collection', 'accession', 'result', 'approval_1', 'approval_2', 'release'] as const;
export const RESULT_TYPES = ['numeric', 'text', 'ordinal', 'coded', 'attachment', 'narrative', 'boolean', 'test_footer', 'space', 'graph', 'html_descriptive'] as const;
export const DISPLAY_TYPES = ['table', 'note_value_only', 'list_note', 'one_column', 'two_column', 'three_column', 'four_column', 'comment', 'hidden', 'table_with_subheader', 'merge_two_column'] as const;
const TEST_UNSET = ['short_name', 'display_name', 'barcode_text', 'description', 'template_ref', 'outsource_name', 'nabl_processing_centres', 'font', 'alert_before_expiry_minutes', 'category_id', 'report_type', 'processing_type'] as const;

const ANALYTE_CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const decimal = exactCode(/^-?\d{1,12}(\.\d{1,6})?$/); // DecimalString: kept as text end to end (13.0 is not 13)
const flagsOf = (...names: string[]): Record<string, V> => Object.fromEntries(names.map((n) => [n, bool]));
const specimenRequirement = (v: unknown) => pick(v, { specimen_type_id: uuid, is_preferred: bool }, ['specimen_type_id']);

const TEST_FIELDS: Record<string, V> = {
  name: str(1, 200), department_id: uuid, workflow_type: oneOf(...WORKFLOWS), report_order: int(0, 9999), short_name: str(1, 60), display_name: str(3, 300),
  tags: list(20, str(1, 60)), barcode_text: str(1, 64), loyalty_points: int(0, 1_000_000), display_order: int(0, 9999), description: str(1, 2000),
  report_type: oneOf(...REPORT_TYPES), processing_type: oneOf(...PROCESSING_TYPES), template_ref: str(1, 120), outsource_name: str(1, 200),
  nabl_processing_centres: list(20, str(1, 200)), font: str(1, 60), alert_before_expiry_minutes: int(0, 525_600), category_id: uuid,
  ...flagsOf('is_orderable', 'uses_existing_material', 'is_outsourced', 'is_popular', 'smart_report', 'print_category_wise', 'nabl', 'accab_logo', 'auto_approval_enabled', 'use_normal_range_for_auto_approval', 'template_test'),
};

/** #24 createTest with every TestCreate field. */
export async function createTestFull(input: unknown, idempotencyKey: string) {
  const body = pick(input, { ...TEST_FIELDS, code: upperCode(), specimen_requirements: list(10, specimenRequirement) }, ['code', 'name', 'department_id', 'workflow_type', 'specimen_requirements']);
  return serverFetch<{ id: string; version: number }>('/v1/catalog/tests', { method: 'POST', headers: json({ 'idempotency-key': idemKey(idempotencyKey) }), body: JSON.stringify(body) });
}

/** #26 updateTest: only the changed fields; cleared optional fields travel as unset[]. */
export async function updateTestFull(testId: string, version: number, input: unknown) {
  const body = pick(input, { ...TEST_FIELDS, is_active: bool, unset: list(12, oneOf(...TEST_UNSET)) });
  return serverFetch<{ version: number }>(`/v1/catalog/tests/${pathId(testId)}`, { method: 'PATCH', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(body) });
}

/** setTestTatTargets: routine / urgent targets (seconds) + the seven stage targets (minutes). */
export async function setTatTargets(testId: string, version: number, input: unknown) {
  const body = pick(input, {
    targets: list(2, (t) => pick(t, { priority: oneOf('routine', 'urgent'), segment: oneOf('within_lab', 'total'), target_seconds: int(60, 2_592_000) }, ['priority', 'segment', 'target_seconds'])),
    stage_targets: list(7, (s) => pick(s, { stage: oneOf(...STAGES), target_minutes: int(0, 43_200) }, ['stage', 'target_minutes'])),
  }, ['targets']);
  return serverFetch<unknown>(`/v1/catalog/tests/${pathId(testId)}/tat-targets`, { method: 'PUT', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(body) });
}

/** replaceTestSpecimenRequirements (1..10 requirements). */
export async function replaceSpecimens(testId: string, version: number, input: unknown) {
  const body = pick(input, { specimen_requirements: list(10, specimenRequirement) }, ['specimen_requirements']);
  if ((body['specimen_requirements'] as unknown[]).length < 1) throw bad();
  return serverFetch<{ version: number }>(`/v1/catalog/tests/${pathId(testId)}/specimen-requirements`, { method: 'PUT', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(body) });
}

const VERSION_FIELDS: Record<string, V> = {
  result_type: oneOf(...RESULT_TYPES), unit_code: str(1, 32), decimals: int(0, 6), method_id: uuid, value_set_code: str(1, 32), formula_expression: str(1, 500),
  default_value: str(1, 500), long_text_value: str(1, 20_000), high_low: decimal, require_verification: bool,
};
const ANALYTE_FIELDS: Record<string, V> = {
  name: str(1, 120), print_name: str(0, 120), report_subheading: str(0, 80), sort_order: int(0, 9999), trend_name: str(1, 120), font: str(1, 60),
  result_display_type: oneOf(...DISPLAY_TYPES), ...flagsOf('print_on_negative', 'print_on_worksheet', 'send_in_sms', 'nabl', 'accab_logo', 'is_trend'),
};

/** #29 createAnalyte with every AnalyteCreate field. */
export async function createAnalyteFull(testId: string, input: unknown, idempotencyKey: string) {
  const body = pick(input, { ...ANALYTE_FIELDS, code: upperCode(ANALYTE_CODE_RE), initial_version: (v) => pick(v, VERSION_FIELDS, ['result_type']) }, ['code', 'name', 'initial_version']);
  return serverFetch<{ id: string; code: string }>(`/v1/catalog/tests/${pathId(testId)}/analytes`, { method: 'POST', headers: json({ 'idempotency-key': idemKey(idempotencyKey) }), body: JSON.stringify(body) });
}

/** #30 updateAnalyte (sort_order, is_active:false for Remove, display fields). Never DELETE. */
export async function updateAnalyteFull(analyteId: string, version: number, input: unknown) {
  const body = pick(input, { ...ANALYTE_FIELDS, is_active: bool, unset: list(4, oneOf('trend_name', 'specimen_type_id', 'font', 'result_display_type')) });
  return serverFetch<{ id: string; version: number }>(`/v1/catalog/analytes/${pathId(analyteId)}`, { method: 'PATCH', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(body) });
}

/** #33 updateAnalyteVersionDraft with the parity fields. */
export async function updateVersionDraftFull(versionId: string, version: number, input: unknown) {
  const body = pick(input, { ...VERSION_FIELDS, unset: list(8, oneOf('unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression', 'default_value', 'long_text_value', 'high_low')) });
  return serverFetch<{ version: number }>(`/v1/catalog/analyte-versions/${pathId(versionId)}`, { method: 'PATCH', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(body) });
}

export interface TestCategory { id: string; department_id: string; name: string; display_order: number; print_footer: boolean; footer_text?: string; is_active: boolean; version: number }
export const listTestCategories = async () => (await serverFetch<{ data: TestCategory[] }>('/v1/catalog/test-categories?is_active=all&limit=200')).data;
const CATEGORY_FIELDS: Record<string, V> = { name: str(1, 200), display_order: int(0, 9999), print_footer: bool, footer_text: str(1, 2000), is_active: bool };
export async function createTestCategory(input: unknown, idempotencyKey: string) {
  const body = pick(input, { ...CATEGORY_FIELDS, department_id: uuid }, ['department_id', 'name']);
  return serverFetch<TestCategory>('/v1/catalog/test-categories', { method: 'POST', headers: json({ 'idempotency-key': idemKey(idempotencyKey) }), body: JSON.stringify(body) });
}
export async function updateTestCategory(id: string, version: number, input: unknown) {
  const body = pick(input, { ...CATEGORY_FIELDS, unset: list(1, oneOf('footer_text')) });
  return serverFetch<TestCategory>(`/v1/catalog/test-categories/${pathId(id)}`, { method: 'PATCH', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(body) });
}

/** createCommentCode with the Notes parity fields (result_type, is_default_template, text_format). */
export async function createCommentCodeFull(input: unknown, idempotencyKey: string) {
  const body = pick(input, { code: upperCode(COMMENT_CODE_RE), department_id: uuid, text: str(1, 2000), category_id: uuid, result_type: oneOf(...RESULT_TYPES), is_default_template: bool, text_format: oneOf('plain', 'markdown') }, ['code', 'text']);
  return serverFetch<{ id: string; version: number }>('/v1/catalog/comment-codes', { method: 'POST', headers: json({ 'idempotency-key': idemKey(idempotencyKey) }), body: JSON.stringify(body) });
}

export type TestDetail = Record<string, any> & { id: string; code: string; name: string; version: number };
const MAX_DETAILS = 200; // ponytail: N+1 detail reads (OrderableSummary has no tags / is_popular / analytes); a list filter in the API (CR) removes them

/** Test details for the given ids (20 at a time, at most 200). */
export async function getTestDetails(ids: readonly string[]): Promise<TestDetail[]> {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string' || !UUID_RE.test(i))) throw bad();
  const out: TestDetail[] = [];
  const wanted = ids.slice(0, MAX_DETAILS);
  for (let i = 0; i < wanted.length; i += 20) out.push(...((await Promise.all(wanted.slice(i, i + 20).map((id) => getTest(id)))) as TestDetail[]));
  return out;
}

/** Every test (summary) plus its detail; used by the Popular tests view and the "Add existing parameter" picker. */
export async function allTestDetails(): Promise<TestDetail[]> {
  const all = await listAllTests({ isActive: 'all' });
  return getTestDetails(all.map((t) => t.id));
}
