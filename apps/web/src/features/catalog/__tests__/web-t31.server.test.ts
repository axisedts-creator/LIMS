// C3.T-31 — BFF server functions for SCR-01…05 (02-CONVENTIONS §2.4: server/<operationId>.server.ts, "server-only" guard).
// MSW stands in for the C3 API (contracts/openapi/catalog.yaml). Synthetic data only.
// ASSUMED signatures (spec gives only file naming + operationIds; named export = operationId):
//   getCatalogHealthReport() → CatalogHealthReport      getCatalogRevision() → {catalog_revision, global_release_seen}
//   list<Master>({isActive?: boolean, limit?, cursor?}) → {data, page}   (Departments, SpecimenTypes, Containers, Methods)
//   listUnits({scope?: 'global'|'tenant', isActive?}) → {data}           listValueSets({scope?, isActive?}) → {data}
//   create<Master>(input, idempotencyKey?) → entity     (code is trimmed + upper-cased by the BFF; Units keep case)
//   update<Master>(id, version, input) → entity         (PATCH + If-Match "<version>"; `code` is immutable and never sent)
// Errors surface as core ApiError (status + problem.code) — same class serverFetch throws.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = '01a1a98a-ac40-7000-8000-0000000d0101';

const seen: { url: URL; method: string; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { seen.push({ url: new URL(r.url), method: r.method, headers: r.headers, body: ['POST', 'PATCH'].includes(r.method) ? await r.clone().json().catch(() => undefined) : undefined }); };
const entity = { id: ID, code: 'HAEM', name: 'Hematology', is_active: true, version: 4, created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-05T04:15:00.000Z' };
const server = setupServer(
  http.get(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
  http.post(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json(entity, { status: 201 }); }),
  http.patch(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json(entity, { status: 200 }); }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; });
afterAll(() => server.close());

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const mod = (op: string) => import(`../server/${op}.server.ts`);

// One row per master resource. `body` is a valid create payload; `patch` a valid update payload; `bad` creates that must be rejected before the network.
const MASTERS = [
  { list: 'listDepartments', create: 'createDepartment', update: 'updateDepartment', path: 'departments', body: { code: 'haem', name: 'Hematology', report_order: 10, report_heading: 'HAEMATOLOGY' }, sent: { code: 'HAEM' },
    patch: { name: 'Haematology', report_order: 20 }, bad: [{ code: 'bad code!', name: 'x', report_order: 1 }, { code: 'A', name: '', report_order: 1 }, { code: 'A', name: 'x'.repeat(101), report_order: 1 }, { code: 'A', name: 'x', report_order: 10000 }, { code: 'A', name: 'x', report_order: -1 }, { code: '_A', name: 'x', report_order: 1 }] },
  { list: 'listSpecimenTypes', create: 'createSpecimenType', update: 'updateSpecimenType', path: 'specimen-types', body: { code: 'edta_wb', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD' }, sent: { code: 'EDTA_WB' },
    patch: { report_label: 'EDTA BLOOD' }, bad: [{ code: 'x y', name: 'n', report_label: 'l' }, { code: 'A', name: 'n', report_label: '' }, { code: 'A', name: 'n', report_label: 'l'.repeat(101) }] },
  { list: 'listContainers', create: 'createContainer', update: 'updateContainer', path: 'containers', body: { code: 'lav_tube', name: 'Lavender tube', additive: 'K2EDTA', cap_colour_display: 'Lavender' }, sent: { code: 'LAV_TUBE' },
    patch: { additive: 'K3EDTA' }, bad: [{ code: 'x y', name: 'n' }, { code: 'A', name: 'n', additive: 'a'.repeat(61) }, { code: 'A', name: 'n', cap_colour_display: 'c'.repeat(41) }, { code: 'A', name: 'n', default_specimen_type_id: 'not-a-uuid' }] },
  { list: 'listMethods', create: 'createMethod', update: 'updateMethod', path: 'methods', body: { code: 'hplc', name: 'HPLC' }, sent: { code: 'HPLC' },
    patch: { name: 'HPLC (ion exchange)' }, bad: [{ code: 'x y', name: 'n' }, { code: 'A', name: 'n'.repeat(121) }] },
] as const;

describe('health report + revision (SCR-01)', () => {
  it('getCatalogHealthReport → GET /v1/catalog/health-report with the session bearer; body returned as-is', async () => {
    const report = { active_orderables_without_default_price: [ID], analytes_without_reference_range: [], tests_without_specimen_type: [], tests_missing_required_analyte: [], tax_default_configured: false, unmapped_formula_inputs: ['HGB'], truncated: true };
    server.use(http.get(`${ORIGIN}/v1/catalog/health-report`, async ({ request }) => { await rec(request); return HttpResponse.json(report); }));
    const { getCatalogHealthReport } = await mod('getCatalogHealthReport');
    expect(await getCatalogHealthReport()).toEqual(report);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/health-report');
  });

  it('getCatalogRevision → GET /v1/catalog/revision', async () => {
    server.use(http.get(`${ORIGIN}/v1/catalog/revision`, async ({ request }) => { await rec(request); return HttpResponse.json({ catalog_revision: 12, global_release_seen: 3 }); }));
    const { getCatalogRevision } = await mod('getCatalogRevision');
    expect(await getCatalogRevision()).toMatchObject({ catalog_revision: 12 });
  });

  it('a 5xx surfaces as ApiError with the code and request_id; the raw detail text is not part of the thrown message', async () => {
    server.use(http.get(`${ORIGIN}/v1/catalog/health-report`, () => problem(500, 'common.internal', { request_id: 'req-abc123', detail: 'pg: relation catalog.secret_table does not exist' })));
    const { getCatalogHealthReport } = await mod('getCatalogHealthReport');
    const err: any = await getCatalogHealthReport().then(() => undefined, (e: unknown) => e);
    expect(err).toBeTruthy();
    expect(err.status).toBe(500);
    expect(err.problem.code).toBe('common.internal');
    expect(String(err.message)).not.toMatch(/secret_table/);
  });
});

describe.each(MASTERS)('$path master (SCR-02…04)', (m) => {
  it(`${m.list} → GET /v1/catalog/${m.path}; isActive maps to is_active; unset filters are omitted`, async () => {
    const fn = (await mod(m.list))[m.list];
    await fn({ isActive: true, limit: 200 });
    await fn({});
    const [a, b] = seen;
    expect(a!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(a!.url.pathname).toBe(`/v1/catalog/${m.path}`);
    expect(a!.url.searchParams.get('is_active')).toBe('true');
    expect(a!.url.searchParams.get('limit')).toBe('200');
    expect(b!.url.search).not.toMatch(/undefined|null|=(&|$)/);
    expect(b!.url.searchParams.has('is_active')).toBe(false); // "All" status = no filter
  });

  it(`${m.list} rejects tampered input before it reaches the API`, async () => {
    const fn = (await mod(m.list))[m.list];
    await expect(fn({ isActive: 'true;drop' as never })).rejects.toBeTruthy();
    await expect(fn({ limit: 201 })).rejects.toBeTruthy();
    await expect(fn({ limit: 0 })).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it(`${m.create} → POST with Idempotency-Key (caller key reused verbatim), upper-cased code, JSON body`, async () => {
    const fn = (await mod(m.create))[m.create];
    await fn(m.body, 'key-abc_123');
    await fn(m.body);
    const [a, b] = seen;
    expect(a!.method).toBe('POST');
    expect(a!.url.pathname).toBe(`/v1/catalog/${m.path}`);
    expect(a!.headers.get('idempotency-key')).toBe('key-abc_123');
    expect(a!.headers.get('content-type')).toMatch(/application\/json/);
    expect(a!.body).toMatchObject(m.sent);
    expect(b!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/); // minted when absent (02-CV §4.5)
    expect(b!.headers.get('idempotency-key')).not.toBe('key-abc_123');
  });

  it(`${m.create} rejects invalid input (regex / length / range) and a bad idempotency key before the network`, async () => {
    const fn = (await mod(m.create))[m.create];
    for (const bad of m.bad) await expect(fn(bad)).rejects.toBeTruthy();
    await expect(fn(m.body, 'has space')).rejects.toBeTruthy();
    await expect(fn(m.body, 'k'.repeat(65))).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it(`${m.create} only forwards known fields (no mass-assignment of id/version/tenant_id)`, async () => {
    const fn = (await mod(m.create))[m.create];
    await fn({ ...m.body, id: ID, version: 99, tenant_id: 'other', is_admin: true });
    expect(Object.keys(seen[0]!.body)).not.toEqual(expect.arrayContaining(['id']));
    for (const k of ['id', 'version', 'tenant_id', 'is_admin']) expect(seen[0]!.body).not.toHaveProperty(k);
  });

  it(`${m.update} → PATCH /${m.path}/{id} with If-Match "<version>"; code is never sent (immutable)`, async () => {
    const fn = (await mod(m.update))[m.update];
    await fn(ID, 3, { ...m.patch, code: 'HACKED' });
    const r = seen[0]!;
    expect(r.method).toBe('PATCH');
    expect(r.url.pathname).toBe(`/v1/catalog/${m.path}/${ID}`);
    expect(r.headers.get('if-match')).toBe('"3"');
    expect(r.body).toMatchObject(m.patch);
    expect(r.body).not.toHaveProperty('code');
  });

  it(`${m.update} rejects a non-uuid id (no path traversal) and a bad version before the network`, async () => {
    const fn = (await mod(m.update))[m.update];
    for (const id of ['../../health-report', 'abc', `${ID}/x`, '']) await expect(fn(id, 1, m.patch)).rejects.toBeTruthy();
    for (const v of [0, -1, 1.5, Number.NaN]) await expect(fn(ID, v, m.patch)).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it(`${m.create}: 409 catalog.code_duplicate and ${m.update}: 409 common.version_conflict / 428 reach the caller as ApiError codes`, async () => {
    server.use(http.post(`${ORIGIN}/v1/catalog/${m.path}`, () => problem(409, 'catalog.code_duplicate')));
    const create = (await mod(m.create))[m.create];
    const e1: any = await create(m.body).then(() => undefined, (e: unknown) => e);
    expect([e1?.status, e1?.problem?.code]).toEqual([409, 'catalog.code_duplicate']);
    server.use(http.patch(`${ORIGIN}/v1/catalog/${m.path}/:id`, () => problem(409, 'common.version_conflict')));
    const update = (await mod(m.update))[m.update];
    const e2: any = await update(ID, 1, m.patch).then(() => undefined, (e: unknown) => e);
    expect([e2?.status, e2?.problem?.code]).toEqual([409, 'common.version_conflict']);
  });
});

describe('units + value sets (SCR-05)', () => {
  it('listUnits → GET /units with scope/is_active; listValueSets → GET /value-sets', async () => {
    const { listUnits } = await mod('listUnits');
    const { listValueSets } = await mod('listValueSets');
    await listUnits({ scope: 'tenant', isActive: true });
    await listValueSets({});
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/units');
    expect(seen[0]!.url.searchParams.get('scope')).toBe('tenant');
    expect(seen[0]!.url.searchParams.get('is_active')).toBe('true');
    expect(seen[1]!.url.pathname).toBe('/v1/catalog/value-sets');
    await expect(listUnits({ scope: 'all' as never })).rejects.toBeTruthy();
    expect(seen).toHaveLength(2);
  });

  it('createUnit keeps the code case (^[A-Za-z0-9_]{1,32}$), sends Idempotency-Key, display ≤ 32', async () => {
    const { createUnit } = await mod('createUnit');
    await createUnit({ code: 'x10_3_per_uL', display: '10^3/µL' }, 'k1');
    expect(seen[0]!.body).toEqual({ code: 'x10_3_per_uL', display: '10^3/µL' });
    expect(seen[0]!.headers.get('idempotency-key')).toBe('k1');
    for (const bad of [{ code: 'bad code', display: 'x' }, { code: 'a-b', display: 'x' }, { code: 'a'.repeat(33), display: 'x' }, { code: 'ok', display: '' }, { code: 'ok', display: 'd'.repeat(33) }]) await expect(createUnit(bad)).rejects.toBeTruthy();
    expect(seen).toHaveLength(1);
  });

  it('updateUnit → PATCH /units/{unit_id} If-Match; only display + is_active are sent', async () => {
    const { updateUnit } = await mod('updateUnit');
    await updateUnit(ID, 2, { display: 'g/dL', is_active: false, code: 'HACK' } as never);
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/units/${ID}`);
    expect(seen[0]!.headers.get('if-match')).toBe('"2"');
    expect(seen[0]!.body).toEqual({ display: 'g/dL', is_active: false });
  });

  it('createValueSet: code upper-cased (^[A-Z0-9_]{1,32}$), value codes ^[A-Z0-9_+\\-]{1,16}$, ≤ 50 values', async () => {
    const { createValueSet } = await mod('createValueSet');
    await createValueSet({ code: 'semi_quant', display: 'Semi-quantitative', is_ordered: true, values: [{ code: 'neg', display: 'Negative', sort_order: 0 }, { code: '1+', display: 'Trace', sort_order: 1 }] }, 'k2');
    expect(seen[0]!.body).toMatchObject({ code: 'SEMI_QUANT', is_ordered: true });
    expect(seen[0]!.body.values.map((v: any) => v.code)).toEqual(['NEG', '1+']);
    const ok = { code: 'A', display: 'd', is_ordered: false };
    await expect(createValueSet({ ...ok, values: [{ code: 'bad value', display: 'x' }] })).rejects.toBeTruthy();
    await expect(createValueSet({ ...ok, values: [{ code: 'A'.repeat(17), display: 'x' }] })).rejects.toBeTruthy();
    await expect(createValueSet({ ...ok, values: Array.from({ length: 51 }, (_, i) => ({ code: `V${i}`, display: 'x' })) })).rejects.toBeTruthy();
    await expect(createValueSet({ ...ok, values: [{ code: 'A', display: 'x'.repeat(41) }] })).rejects.toBeTruthy();
    expect(seen).toHaveLength(1);
  });

  it('updateValueSet → PATCH /value-sets/{value_set_id} If-Match; 409 catalog.version_in_use reaches the caller', async () => {
    const { updateValueSet } = await mod('updateValueSet');
    await updateValueSet(ID, 5, { display: 'New display', values: [{ code: 'POS', display: 'Positive', sort_order: 0, is_active: true }] });
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/value-sets/${ID}`);
    expect(seen[0]!.headers.get('if-match')).toBe('"5"');
    expect(seen[0]!.body.values[0]).toMatchObject({ code: 'POS' });
    server.use(http.patch(`${ORIGIN}/v1/catalog/value-sets/:id`, () => problem(409, 'catalog.version_in_use')));
    const e: any = await updateValueSet(ID, 5, { display: 'x' }).then(() => undefined, (x: unknown) => x);
    expect([e?.status, e?.problem?.code]).toEqual([409, 'catalog.version_in_use']);
  });
});
