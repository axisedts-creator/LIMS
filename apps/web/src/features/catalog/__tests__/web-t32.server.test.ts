// C3.T-32 — BFF server functions for SCR-06…08 (04-UI-UX §1/§4, 02-TRD §4 routes #24–#51, 02-CONVENTIONS §2.4/§4.5).
// ACs: AC-03.6/05.9 (privileged publish: If-Match + Idempotency-Key + mfa_required passthrough), AC-04.8 (validate = read-only POST),
// AC-05.1.. (preview panel data), REQ-SEC-028 (UUID ids only in paths), REQ-SEC-068 (bearer never leaves the server).
// Server functions run for real against MSW. Synthetic data only.
// ASSUMED module contract (spec fixes only the folder `features/catalog/` and the C3 route table; writer may dispute names):
//   server/getTest.server.ts                   getTest(testId)                                   GET  #25
//   server/getAnalyte.server.ts                getAnalyte(analyteId)                             GET  #30
//   server/validateFormula.server.ts           validateFormula({analyte_id?, expression, sample_inputs?, sample_context?})  POST #36
//   server/createAnalyteVersionDraft.server.ts createAnalyteVersionDraft(analyteId, idempotencyKey, copyFromVersionNo?)      POST #32
//   server/updateAnalyteVersionDraft.server.ts updateAnalyteVersionDraft(versionId, version, fields)                         PATCH #33 (If-Match)
//   server/publishAnalyteVersion.server.ts     publishAnalyteVersion(versionId, version, body, idempotencyKey)               POST #34 (If-Match, Idempotency-Key)
//   server/publishRangeSet.server.ts           publishReferenceRangeSet / publishCriticalLimitSet(setId, version, {effective_from?, change_reason}, idempotencyKey)  #41/#48
//   server/replaceBands.server.ts              replaceReferenceRangeBands / replaceCriticalLimitBands(setId, version, bands)  PUT #40/#47 (If-Match)
//   server/retireRangeSet.server.ts            retireReferenceRangeSet / retireCriticalLimitSet(setId, version, {change_reason, effective_at?}, idempotencyKey)  #42/#49 (If-Match, Idempotency-Key)
//   server/discardRangeSet.server.ts           discardReferenceRangeSetDraft / discardCriticalLimitSetDraft(setId, version)     #43/#50 (If-Match)
//   server/previewReferenceRange.server.ts    previewReferenceRange({analyte_id, sex, age_days, birth_on?, specimen_type_code?, at?})  POST #51
//   errors: ApiError from '@/core/api/server-fetch' (status + problem.code), as in features/instruments/server.
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
const ID = '01a1a98a-ac40-7000-8000-0000000c3001';
const SET = '01a1a98a-ac40-7000-8000-0000000c3002';
const KEY = '01a1a98a-ac40-7000-8000-0000000c30ee';

interface Seen { method: string; url: URL; headers: Headers; body?: any }
const seen: Seen[] = [];
const rec = (fn: (s: Seen) => Response | Promise<Response>) => async ({ request }: { request: Request }) => {
  const s: Seen = { method: request.method, url: new URL(request.url), headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().json().catch(() => undefined) };
  seen.push(s);
  return fn(s);
};
const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });
const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => api.resetHandlers());
afterAll(() => api.close());
beforeEach(() => { seen.length = 0; });

const load = async <T = Record<string, (...a: any[]) => Promise<any>>>(file: string): Promise<T> => (await import(/* @vite-ignore */ `../server/${file}.server`)) as T;

describe('validateFormula (#36, AC-04.8) — read-only POST', () => {
  it('POSTs the body to /v1/catalog/formulas/validate with bearer, no Idempotency-Key, no If-Match; returns the 200 result as is', async () => {
    const result = { valid: true, input_analyte_codes: ['MCV', 'RBC'], dependency_order: ['MCV', 'RBC', 'MENTZER'], chain_depth: 2, sample_result: '13.5', errors: [] };
    api.use(http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json(result))));
    const { validateFormula } = await load('validateFormula');
    const out = await validateFormula({ analyte_id: ID, expression: 'MCV / RBC', sample_inputs: { MCV: '81.0', RBC: '6.0' }, sample_context: { age_days: 9000, sex: 'male' } });
    expect(out).toEqual(result);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(seen[0]!.headers.get('idempotency-key')).toBeNull();
    expect(seen[0]!.headers.get('if-match')).toBeNull();
    expect(seen[0]!.body).toEqual({ analyte_id: ID, expression: 'MCV / RBC', sample_inputs: { MCV: '81.0', RBC: '6.0' }, sample_context: { age_days: 9000, sex: 'male' } });
  });

  it('an invalid formula is data (200 valid:false with positioned errors), not a thrown error', async () => {
    const result = { valid: false, input_analyte_codes: [], dependency_order: [], chain_depth: 0, errors: [{ path: '/expression', code: 'catalog.formula_invalid', message: 'Unexpected ")"' }] };
    api.use(http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json(result))));
    const { validateFormula } = await load('validateFormula');
    await expect(validateFormula({ expression: '(1 + ' })).resolves.toMatchObject({ valid: false });
  });

  it('refuses an empty or >500-char expression client-side (no request) — mirrors #36 1–500', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json({}))));
    const { validateFormula } = await load('validateFormula');
    await expect(validateFormula({ expression: '' })).rejects.toMatchObject({ status: 400 });
    await expect(validateFormula({ expression: 'A'.repeat(501) })).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
  });

  it('a non-UUID analyte_id is refused before any request (REQ-SEC-028)', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json({}))));
    const { validateFormula } = await load('validateFormula');
    await expect(validateFormula({ analyte_id: '../../admin', expression: 'A + 1' })).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
  });
});

describe('publishAnalyteVersion (#34, AC-03.1/03.3/03.5/03.6)', () => {
  const body = { effective_from: '2026-11-08T04:15:00.000Z', change_reason: 'Synthetic change reason', reference_range_set_id: SET, critical_limit_set_id: SET, allow_without_ranges: false };

  it('POST /analyte-versions/{id}/publish with If-Match "<version>" and the caller\'s Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => HttpResponse.json({ id: ID, status: 'published', version: 4 }))));
    const { publishAnalyteVersion } = await load('publishAnalyteVersion');
    await publishAnalyteVersion(ID, 3, body, KEY);
    const s = seen[0]!;
    expect(s.url.pathname).toBe(`/v1/catalog/analyte-versions/${ID}/publish`);
    expect(s.headers.get('if-match')).toBe('"3"');
    expect(s.headers.get('idempotency-key')).toBe(KEY);
    expect(s.body).toEqual(body);
  });

  it.each([
    ['auth.mfa_required', 403],
    ['auth.forbidden', 403],
    ['catalog.version_in_use', 409],
    ['common.version_conflict', 409],
    ['catalog.formula_invalid', 422],
    ['common.precondition_required', 428],
  ])('%s (%i) surfaces as ApiError with that code', async (code, status) => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => problem(code, status))));
    const { publishAnalyteVersion } = await load('publishAnalyteVersion');
    await expect(publishAnalyteVersion(ID, 3, body, KEY)).rejects.toMatchObject({ status, problem: { code } });
  });

  it('400 keeps the per-field errors[] (path /effective_from, /reference_range_set_id) for the form to place', async () => {
    const errors = [{ path: '/effective_from', code: 'common.validation_failed', message: 'in the past' }];
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => problem('common.validation_failed', 400, { errors }))));
    const { publishAnalyteVersion } = await load('publishAnalyteVersion');
    await expect(publishAnalyteVersion(ID, 3, body, KEY)).rejects.toMatchObject({ status: 400, problem: { errors } });
  });

  it('refuses a missing Idempotency-Key, empty/over-500 change_reason, non-integer version or non-UUID id — nothing is sent', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => HttpResponse.json({}))));
    const { publishAnalyteVersion } = await load('publishAnalyteVersion');
    await expect(publishAnalyteVersion(ID, 3, body, '')).rejects.toMatchObject({ status: 400 });
    await expect(publishAnalyteVersion(ID, 3, { ...body, change_reason: '' }, KEY)).rejects.toMatchObject({ status: 400 });
    await expect(publishAnalyteVersion(ID, 3, { ...body, change_reason: 'x'.repeat(501) }, KEY)).rejects.toMatchObject({ status: 400 });
    await expect(publishAnalyteVersion(ID, 1.5, body, KEY)).rejects.toMatchObject({ status: 400 });
    await expect(publishAnalyteVersion('1; DROP TABLE', 3, body, KEY)).rejects.toMatchObject({ status: 404 });
    expect(seen).toHaveLength(0);
  });
});

describe('range / critical sets (#38–#51, AC-05.7/05.9)', () => {
  it.each([
    ['publishReferenceRangeSet', 'reference-range-sets'],
    ['publishCriticalLimitSet', 'critical-limit-sets'],
  ])('%s → POST /v1/catalog/%s/{id}/publish with If-Match, Idempotency-Key, change_reason', async (fn, seg) => {
    api.use(http.post(`${ORIGIN}/v1/catalog/${seg}/:id/publish`, rec(() => HttpResponse.json({ id: SET, status: 'published', version: 2 }))));
    const mod = await load('publishRangeSet');
    await mod[fn](SET, 2, { change_reason: 'Synthetic change reason' }, KEY);
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/${seg}/${SET}/publish`);
    expect(seen[0]!.headers.get('if-match')).toBe('"2"');
    expect(seen[0]!.headers.get('idempotency-key')).toBe(KEY);
    expect(seen[0]!.body).toEqual({ change_reason: 'Synthetic change reason' });
  });

  it('publish: overlap 400 keeps errors[] naming both band indexes (no partial publish shown as success)', async () => {
    const errors = [{ path: '/bands/0', code: 'common.validation_failed', message: 'overlaps band 1' }, { path: '/bands/1', code: 'common.validation_failed', message: 'overlaps band 0' }];
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/publish`, rec(() => problem('common.validation_failed', 400, { errors }))));
    const mod = await load('publishRangeSet');
    await expect(mod.publishReferenceRangeSet(SET, 2, { change_reason: 'r' }, KEY)).rejects.toMatchObject({ status: 400, problem: { errors } });
  });

  it('publish without change_reason is refused client-side (AC-05.9 1–500)', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/publish`, rec(() => HttpResponse.json({}))));
    const mod = await load('publishRangeSet');
    await expect(mod.publishReferenceRangeSet(SET, 2, { change_reason: '   ' }, KEY)).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
  });

  it('replaceReferenceRangeBands → PUT {bands} with If-Match; decimals stay strings (no Number() rounding)', async () => {
    api.use(http.put(`${ORIGIN}/v1/catalog/reference-range-sets/:id/bands`, rec(() => HttpResponse.json({ id: SET, version: 3 }))));
    const mod = await load('replaceBands');
    const bands = [{ sex: 'male', age_low: { value: 18, unit: 'year' }, kind: 'numeric', low: '13.0', high: '17.0', sort_order: 0 }];
    await mod.replaceReferenceRangeBands(SET, 2, bands);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.headers.get('if-match')).toBe('"2"');
    expect(seen[0]!.body).toEqual({ bands });
    expect(typeof seen[0]!.body.bands[0].low).toBe('string');
  });

  // 02-TRD §5: If-Match on every state-changing action on an existing resource; API answers 428 common.precondition_required without it.
  it.each([
    ['retireReferenceRangeSet', 'reference-range-sets', '#42'],
    ['retireCriticalLimitSet', 'critical-limit-sets', '#49'],
  ])('%s (%s, %s) → POST /{id}/retire with If-Match "<version>", Idempotency-Key, change_reason', async (fn, seg) => {
    api.use(http.post(`${ORIGIN}/v1/catalog/${seg}/:id/retire`, rec(() => HttpResponse.json({ id: SET, status: 'retired', version: 3 }))));
    const mod = await load('retireRangeSet');
    await mod[fn](SET, 2, { change_reason: 'Synthetic retire reason' }, KEY);
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/${seg}/${SET}/retire`);
    expect(seen[0]!.headers.get('if-match')).toBe('"2"');
    expect(seen[0]!.headers.get('idempotency-key')).toBe(KEY);
    expect(seen[0]!.body).toEqual({ change_reason: 'Synthetic retire reason' });
  });

  it('retire refuses a blank change_reason, missing Idempotency-Key, non-integer version or non-UUID id before any request', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/retire`, rec(() => HttpResponse.json({}))));
    const mod = await load('retireRangeSet');
    await expect(mod.retireReferenceRangeSet(SET, 2, { change_reason: '   ' }, KEY)).rejects.toMatchObject({ status: 400 });
    await expect(mod.retireReferenceRangeSet(SET, 2, { change_reason: 'r' }, '')).rejects.toMatchObject({ status: 400 });
    await expect(mod.retireReferenceRangeSet(SET, 1.5, { change_reason: 'r' }, KEY)).rejects.toMatchObject({ status: 400 });
    // ruling C3.T-32: no spec line fixes a status for a malformed id; BFF convention is 404 (see publishAnalyteVersion / getTest).
    await expect(mod.retireReferenceRangeSet('not-a-uuid', 2, { change_reason: 'r' }, KEY)).rejects.toMatchObject({ status: 404 });
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['discardReferenceRangeSetDraft', 'reference-range-sets', '#43'],
    ['discardCriticalLimitSetDraft', 'critical-limit-sets', '#50'],
  ])('%s (%s, %s) → POST /{id}/discard with If-Match "<version>"', async (fn, seg) => {
    api.use(http.post(`${ORIGIN}/v1/catalog/${seg}/:id/discard`, rec(() => HttpResponse.json({ id: SET, status: 'discarded', version: 3 }))));
    const mod = await load('discardRangeSet');
    await mod[fn](SET, 2);
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/${seg}/${SET}/discard`);
    expect(seen[0]!.headers.get('if-match')).toBe('"2"');
  });

  it('discard refuses a non-integer version or non-UUID id before any request', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/discard`, rec(() => HttpResponse.json({}))));
    const mod = await load('discardRangeSet');
    await expect(mod.discardReferenceRangeSetDraft(SET, 1.5)).rejects.toMatchObject({ status: 400 });
    // ruling C3.T-32: 404 for malformed id (BFF convention).
    await expect(mod.discardReferenceRangeSetDraft('not-a-uuid', 2)).rejects.toMatchObject({ status: 404 });
    expect(seen).toHaveLength(0);
  });

  it('previewReferenceRange (#51) → POST with the profile; returns match, critical limits, no_reference_range', async () => {
    const res = { reference_range: { reference_range_id: SET, version: 3, low: '13.0', high: '17.0', unit_code: 'g_dl', kind: 'numeric' }, no_reference_range: false };
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-ranges/preview`, rec(() => HttpResponse.json(res))));
    const { previewReferenceRange } = await load('previewReferenceRange');
    const out = await previewReferenceRange({ analyte_id: ID, sex: 'male', age_days: 9000 });
    expect(out).toEqual(res);
    expect(seen[0]!.body).toEqual({ analyte_id: ID, sex: 'male', age_days: 9000 });
    expect(seen[0]!.headers.get('idempotency-key')).toBeNull();
  });

  it('previewReferenceRange refuses age_days outside 0–73000 and sex outside the enum before any request', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-ranges/preview`, rec(() => HttpResponse.json({}))));
    const { previewReferenceRange } = await load('previewReferenceRange');
    await expect(previewReferenceRange({ analyte_id: ID, sex: 'male', age_days: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(previewReferenceRange({ analyte_id: ID, sex: 'male', age_days: 73001 })).rejects.toMatchObject({ status: 400 });
    await expect(previewReferenceRange({ analyte_id: ID, sex: 'martian' as never, age_days: 5 })).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
  });
});

describe('reads + drafts', () => {
  it('getTest / getAnalyte: GET by UUID only; 404 for other-tenant ids passes through; non-UUID never reaches the API', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/catalog/tests/:id`, rec(() => problem('common.not_found', 404))),
      http.get(`${ORIGIN}/v1/catalog/analytes/:id`, rec(() => HttpResponse.json({ id: ID, versions: [] }))),
    );
    const t = await load('getTest');
    const a = await load('getAnalyte');
    await expect(t.getTest(ID)).rejects.toMatchObject({ status: 404 });
    await expect(a.getAnalyte(ID)).resolves.toMatchObject({ id: ID });
    await expect(t.getTest('CBC')).rejects.toMatchObject({ status: 404 }); // codes are never path identifiers
    expect(seen.map((s) => s.url.pathname)).toEqual([`/v1/catalog/tests/${ID}`, `/v1/catalog/analytes/${ID}`]);
  });

  it('createAnalyteVersionDraft (#32): POST with Idempotency-Key; 409 common.version_conflict when a draft exists', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analytes/:id/versions`, rec(() => problem('common.version_conflict', 409))));
    const { createAnalyteVersionDraft } = await load('createAnalyteVersionDraft');
    await expect(createAnalyteVersionDraft(ID, KEY)).rejects.toMatchObject({ status: 409, problem: { code: 'common.version_conflict' } });
    expect(seen[0]!.headers.get('idempotency-key')).toBe(KEY);
    await expect(createAnalyteVersionDraft(ID, '')).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
  });

  it('updateAnalyteVersionDraft (#33): PATCH with If-Match; 409 catalog.version_in_use for a published version', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/analyte-versions/:id`, rec(() => problem('catalog.version_in_use', 409))));
    const { updateAnalyteVersionDraft } = await load('updateAnalyteVersionDraft');
    await expect(updateAnalyteVersionDraft(ID, 2, { decimals: 2 })).rejects.toMatchObject({ status: 409, problem: { code: 'catalog.version_in_use' } });
    expect(seen[0]!.method).toBe('PATCH');
    expect(seen[0]!.headers.get('if-match')).toBe('"2"');
    expect(seen[0]!.body).toEqual({ decimals: 2 });
  });
});
