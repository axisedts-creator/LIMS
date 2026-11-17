// T0D-TESTMGMT-1 (LD-318): BFF "typed calls for the new fields". Server functions run for real against MSW. Synthetic data only.
// Pinned names (file = function name + .server.ts, as the rest of features/catalog/server):
//   createTest / updateTest      forward every TestCreate / TestUpdate field of the contract (today only 5 / 6 are forwarded)
//   setTestTatTargets(testId, version, {targets, stage_targets})   PUT /tests/{id}/tat-targets, If-Match
//   listTestCategories(q) / createTestCategory(input, key?) / updateTestCategory(id, version, input)   /v1/catalog/test-categories
//   createAnalyte / updateAnalyte forward the new analyte fields (result_display_type, print_on_negative, ... trend_name) in input and initial_version
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/catalog/tests',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = '01a1a98a-ac40-7000-8000-0000000f1001';
const DEPT = '01a1a98a-ac40-7000-8000-0000000f1002';
const SPEC = '01a1a98a-ac40-7000-8000-0000000f1003';
const CAT = '01a1a98a-ac40-7000-8000-0000000f1004';
const KEY = '01a1a98a-ac40-7000-8000-0000000f10ee';

interface Seen { method: string; url: URL; headers: Headers; body?: any }
const seen: Seen[] = [];
const rec = (status = 200, out: unknown = {}) => async ({ request }: { request: Request }) => {
  seen.push({ method: request.method, url: new URL(request.url), headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().json().catch(() => undefined) });
  return HttpResponse.json(out as object, { status });
};
const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => api.resetHandlers());
afterAll(() => api.close());
beforeEach(() => { seen.length = 0; });
const load = async <T = Record<string, (...a: any[]) => Promise<any>>>(file: string): Promise<T> => (await import(/* @vite-ignore */ `../server/${file}.server`)) as T;

const NEW_TEST = {
  short_name: 'CBC', display_name: 'COMPLETE BLOOD COUNT, EDTA WB(CBC)', tags: ['anaemia'], barcode_text: 'CBC', loyalty_points: 5, display_order: 10, description: 'Synthetic',
  report_type: 'four_column', processing_type: 'local', template_ref: 'tpl-1', outsource_name: 'Synthetic lab', is_outsourced: false, is_popular: true, smart_report: true,
  print_category_wise: false, nabl: true, accab_logo: false, auto_approval_enabled: true, use_normal_range_for_auto_approval: false, template_test: false,
  nabl_processing_centres: ['Centre A'], font: 'Arial', alert_before_expiry_minutes: 30, category_id: CAT, report_order: 100, is_orderable: true, uses_existing_material: false,
};

describe('createTest / updateTest forward the parity fields', () => {
  it('createTest sends every TestCreate field and drops unknown ones', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tests`, rec(201, { id: ID })));
    const { createTest } = await load('createTest');
    await createTest({ code: 'cbc', name: 'CBC', department_id: DEPT, workflow_type: 'standard', specimen_requirements: [{ specimen_type_id: SPEC, is_preferred: true }], ...NEW_TEST, evil: 1 }, KEY);
    expect(seen[0]!.body).toEqual({ code: 'CBC', name: 'CBC', department_id: DEPT, workflow_type: 'standard', specimen_requirements: [{ specimen_type_id: SPEC, is_preferred: true }], ...NEW_TEST });
  });

  it.each([
    ['report_type', 'nonsense'], ['processing_type', 'teleport'], ['loyalty_points', -1], ['alert_before_expiry_minutes', 525601], ['tags', Array.from({ length: 21 }, (_, i) => `t${i}`)],
    ['display_name', 'ab'], ['category_id', 'not-a-uuid'],
  ])('createTest rejects a bad %s before any request', async (k, v) => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tests`, rec(201, { id: ID }))); // reaching the API at all = the bad value was not validated
    const { createTest } = await load('createTest');
    await expect(createTest({ code: 'X', name: 'X', department_id: DEPT, workflow_type: 'standard', specimen_requirements: [{ specimen_type_id: SPEC }], [k]: v }, KEY)).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
  });

  it('updateTest sends the new fields with If-Match', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/tests/${ID}`, rec(200, { id: ID })));
    const { updateTest } = await load('updateTest');
    await updateTest(ID, 4, NEW_TEST);
    expect(seen[0]!.headers.get('if-match')).toBe('"4"');
    expect(seen[0]!.body).toEqual(NEW_TEST);
  });
});

describe('setTestTatTargets', () => {
  it('PUTs targets and the seven stage targets (minutes) with If-Match', async () => {
    api.use(http.put(`${ORIGIN}/v1/catalog/tests/${ID}/tat-targets`, rec(200, { targets: [], stage_targets: [] })));
    const { setTestTatTargets } = await load('setTestTatTargets');
    const stage_targets = ['registration', 'sample_collection', 'accession', 'result', 'approval_1', 'approval_2', 'release'].map((stage, i) => ({ stage, target_minutes: i * 10 }));
    await setTestTatTargets(ID, 4, { targets: [], stage_targets });
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.headers.get('if-match')).toBe('"4"');
    expect(seen[0]!.body).toEqual({ targets: [], stage_targets });
  });

  it('rejects an eighth stage, a negative or >43200 minute value and an unknown stage before any request', async () => {
    const { setTestTatTargets } = await load('setTestTatTargets');
    for (const st of [Array.from({ length: 8 }, () => ({ stage: 'result', target_minutes: 1 })), [{ stage: 'result', target_minutes: -1 }], [{ stage: 'result', target_minutes: 43201 }], [{ stage: 'lunch', target_minutes: 1 }]]) {
      await expect(setTestTatTargets(ID, 1, { targets: [], stage_targets: st })).rejects.toMatchObject({ status: 400 });
    }
    expect(seen).toHaveLength(0);
  });
});

describe('test categories', () => {
  it('list GETs /test-categories; create POSTs with Idempotency-Key; update PATCHes with If-Match', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/catalog/test-categories`, rec(200, { data: [], page: { limit: 50 } })),
      http.post(`${ORIGIN}/v1/catalog/test-categories`, rec(201, { id: CAT })),
      http.patch(`${ORIGIN}/v1/catalog/test-categories/${CAT}`, rec(200, { id: CAT })),
    );
    const { listTestCategories } = await load('listTestCategories');
    const { createTestCategory } = await load('createTestCategory');
    const { updateTestCategory } = await load('updateTestCategory');
    await listTestCategories({});
    await createTestCategory({ department_id: DEPT, name: 'Lipids', display_order: 5, print_footer: true, footer_text: 'F', evil: 1 }, KEY);
    await updateTestCategory(CAT, 2, { name: 'Lipids 2', is_active: false });
    expect(seen.map((s) => s.method)).toEqual(['GET', 'POST', 'PATCH']);
    expect(seen[1]!.headers.get('idempotency-key')).toBe(KEY);
    expect(seen[1]!.body).toEqual({ department_id: DEPT, name: 'Lipids', display_order: 5, print_footer: true, footer_text: 'F' });
    expect(seen[2]!.headers.get('if-match')).toBe('"2"');
    expect(seen[2]!.body).toEqual({ name: 'Lipids 2', is_active: false });
  });

  it('a non-UUID id never leaves the server', async () => {
    const { updateTestCategory } = await load('updateTestCategory');
    await expect(updateTestCategory('../x', 1, { name: 'x' })).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
  });
});

describe('analyte fields', () => {
  it('createAnalyte forwards the parity analyte fields and the initial version fields', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tests/${ID}/analytes`, rec(201, { id: ID, code: 'HB' })));
    const { createAnalyte } = await load('createAnalyte');
    const input = {
      code: 'HB', name: 'Hemoglobin', print_name: 'Hb', report_subheading: 'Red cells', sort_order: 10, is_reportable: true, trend_name: 'Hb trend', font: 'Arial',
      result_display_type: 'table', print_on_negative: true, print_on_worksheet: false, send_in_sms: true, nabl: false, accab_logo: false, is_trend: true,
      initial_version: { result_type: 'numeric', unit_code: 'g_dL', decimals: 1, default_value: '0', high_low: '99.9', require_verification: true, formula_expression: 'RBC*3' },
    };
    await createAnalyte(ID, input as any, KEY);
    expect(seen[0]!.body).toEqual(input);
  });

  it('updateAnalyte forwards result_display_type, print flags and unset', async () => {
    const A = '01a1a98a-ac40-7000-8000-0000000f1005';
    api.use(http.patch(`${ORIGIN}/v1/catalog/analytes/${A}`, rec(200, { id: A })));
    const { updateAnalyte } = await load('updateAnalyte');
    const f = { result_display_type: 'four_column', print_on_negative: false, send_in_sms: true, unset: ['font'] };
    await updateAnalyte(A, 3, f as any);
    expect(seen[0]!.body).toEqual(f);
  });
});
