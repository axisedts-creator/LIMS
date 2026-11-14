// C10.T-22 — server/listLabCodedSet.server.ts (BFF over C5 GET /v1/lab/coded-sets/{set_name}): the reopen reasons exclude the three system codes (08 A17 D-62; 07-SECURITY S-30).
// REQ-SEC-026/027: the set name is validated before any request. Failures never break the dialog (-> []). Pinned seam: see t22.harness.tsx header. Node environment (server code).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { AMEND_REASONS, LAB_REASONS, ORIGIN, SYSTEM_CODES, amendCode, api, hit, hits, labReasonsHandler, resetHits, state } from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); state.token = 'jwt-synthetic'; api.use(labReasonsHandler()); });
afterEach(() => api.resetHandlers());
afterAll(() => api.close());

const load = async () => (await import('../server/listLabCodedSet.server')).listLabCodedSet;

describe('amendment_reasons (D-62)', () => {
  it('removes module_phase_progression, module_preliminary_update and supplementary_report', async () => {
    const rows = await (await load())('amendment_reasons');
    for (const c of SYSTEM_CODES) expect(rows.map((r) => r.code), c).not.toContain(c);
    expect(rows.map((r) => r.display.toLowerCase()).join('|')).not.toMatch(/preliminary to final|updated preliminary|supplementary report/);
  });
  it('keeps global and tenant codes in the API order and drops inactive ones', async () => {
    const rows = await (await load())('amendment_reasons');
    expect(rows.map((r) => r.code)).toEqual(['syn_transcription_error', 'syn_new_information']);
  });
  it('returns only { code, display } (no source, sort order or other internals leave the BFF)', async () => {
    const rows = await (await load())('amendment_reasons');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['code', 'display']);
  });
  it('the filter is exact: a code that merely contains a system code stays', async () => {
    api.use(labReasonsHandler([...AMEND_REASONS, amendCode('module_phase_progression_typo', 'Synthetic lookalike'), amendCode('supplementary_report_2', 'Synthetic second')]));
    const codes = (await (await load())('amendment_reasons')).map((r) => r.code);
    expect(codes).toContain('module_phase_progression_typo');
    expect(codes).toContain('supplementary_report_2');
    for (const c of SYSTEM_CODES) expect(codes).not.toContain(c);
  });
  it('calls GET /v1/lab/coded-sets/amendment_reasons once with the session token', async () => {
    await (await load())('amendment_reasons');
    const h = hit('GET', LAB_REASONS);
    expect(h).toHaveLength(1);
    expect(h[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });
});

describe('failure and validation', () => {
  it.each([403, 404, 500, 503])('API %i -> [] (the dialog stays usable), no throw', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => HttpResponse.json({ code: 'x', title: 'x', status }, { status })));
    await expect((await load())('amendment_reasons')).resolves.toEqual([]);
  });
  it('a network error -> []', async () => {
    api.use(http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => HttpResponse.error()));
    await expect((await load())('amendment_reasons')).resolves.toEqual([]);
  });
  it('a malformed body (no data array) -> []', async () => {
    api.use(http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => HttpResponse.json({ rows: 'nope' })));
    await expect((await load())('amendment_reasons')).resolves.toEqual([]);
  });
  it.each(['users', '../settings', 'amendment_reasons/x', 'amendment_reasons?x=1', '', 'AMENDMENT_REASONS', 'micro.culture_outcomes'])('set name %j is refused before any request', async (name) => {
    await expect((await load())(name as never)).resolves.toEqual([]);
    expect(hits).toHaveLength(0);
  });
  it.each(['rejection_reasons', 'return_reasons', 'exception_discard_reasons'])('the other lab sets (%s) are allowed names', async (name) => {
    api.use(http.get(`${ORIGIN}/v1/lab/coded-sets/${name}`, () => HttpResponse.json({ data: [amendCode('syn_a', 'Synthetic A')] })));
    expect((await (await load())(name as never)).map((r) => r.code)).toEqual(['syn_a']);
  });
  it('nothing is logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    api.use(http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => HttpResponse.error()));
    await (await load())('amendment_reasons');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
