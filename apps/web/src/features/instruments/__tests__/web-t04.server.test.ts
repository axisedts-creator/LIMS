// WEB-T04 — BFF server functions for SCR-08 mappings: C3 #92–#95 (listInstrumentCodeMaps, createInstrumentCodeMap,
// updateInstrumentCodeMap, upsertInstrumentCodeMaps) + E32 listObservedInstrumentCodes, plus static guards.
// ACs: AC-17.1 (list), AC-17.2 (create body + C3 errors), AC-17.4 / 08 A13 D-39 + 07-SECURITY S-04 (no `catalog.instrument_code_map.manage`
//      → NO C3 code-map call and no write via the BFF), done_when "create/edit/deactivate/copy".
// ASSUMED module/signature contract (spec gives operationIds + folders only; dispute to rename):
//   server/listInstrumentCodeMaps.server.ts     listInstrumentCodeMaps(instrumentId, q?: {direction?, analyteId?, isActive?, cursor?})  GET  /v1/catalog/instrument-code-maps?instrument_id=
//   server/listObservedInstrumentCodes.server.ts listObservedInstrumentCodes(instrumentId, q?: {recordClass?, mappingStatus?, limit?, cursor?})  GET /v1/instruments/instruments/{id}/observed-codes (E32)
//   server/createInstrumentCodeMap.server.ts    createInstrumentCodeMap(input, idempotencyKey)                POST /v1/catalog/instrument-code-maps (Idempotency-Key)
//   server/updateInstrumentCodeMap.server.ts    updateInstrumentCodeMap(mapId, version, patch)                PATCH /v1/catalog/instrument-code-maps/{id}, If-Match "<version>"
//   server/upsertInstrumentCodeMaps.server.ts   upsertInstrumentCodeMaps(instrumentId, maps, idempotencyKey)  POST /v1/catalog/instrument-code-maps/bulk-upsert (Idempotency-Key)
//   server/actions.ts   createInstrumentCodeMapAction(input, key) · updateInstrumentCodeMapAction(mapId, version, patch) · upsertInstrumentCodeMapsAction(instrumentId, maps, key) → ActionResult
// The four C3 functions check the SESSION permission `catalog.instrument_code_map.manage` themselves (defence in depth, D-39/S-04) and throw
// ApiError(403 auth.forbidden) BEFORE any network call. Invalid input throws ApiError(400 common.validation_failed) BEFORE any network call.
// Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] | undefined }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => (session.permissions ? { actor: { permissions: session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } } : undefined),
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const MAN = 'catalog.instrument_code_map.manage';
const MANAGE = ['instruments.instrument.read', MAN];
const READ = ['instruments.instrument.read'];
session.permissions = MANAGE;

const INST = '01a1a98a-ac40-7000-8000-0000000e0001';
const MAP = '01a1a98a-ac40-7000-8000-0000000a0001';
const TEST = '01a1a98a-ac40-7000-8000-0000000b0001';
const ANALYTE = '01a1a98a-ac40-7000-8000-0000000b0002';
const MAPS = `${ORIGIN}/v1/catalog/instrument-code-maps`;
const OBS = `${ORIGIN}/v1/instruments/instruments/${INST}/observed-codes`;

const input = (o: Record<string, unknown> = {}) => ({ instrument_id: INST, direction: 'both', instrument_code: 'HGB', analyte_id: ANALYTE, test_id: TEST, ...o });
const row = (o: Record<string, unknown> = {}) => ({ id: MAP, ...input(), is_active: true, version: 3, ...o });
const KEY = 'idem-key-synthetic-1';

const seen: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { seen.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });
const server = setupServer(
  http.get(MAPS, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [row()], page: { limit: 50 } }); }),
  http.post(MAPS, async ({ request }) => { await rec(request); return HttpResponse.json(row({ version: 1 }), { status: 201 }); }),
  http.patch(`${MAPS}/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(row({ version: 4 })); }),
  http.post(`${MAPS}/bulk-upsert`, async ({ request }) => { await rec(request); return HttpResponse.json({ results: [{ direction: 'both', instrument_code: 'HGB', outcome: 'created' }] }); }),
  http.get(OBS, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; session.permissions = MANAGE; });
afterAll(() => server.close());

// literal specifiers (a template-string import cannot be resolved by vite without a file extension)
const MODS: Record<string, () => Promise<any>> = {
  listInstrumentCodeMaps: () => import('../server/listInstrumentCodeMaps.server'),
  listObservedInstrumentCodes: () => import('../server/listObservedInstrumentCodes.server'),
  createInstrumentCodeMap: () => import('../server/createInstrumentCodeMap.server'),
  updateInstrumentCodeMap: () => import('../server/updateInstrumentCodeMap.server'),
  upsertInstrumentCodeMaps: () => import('../server/upsertInstrumentCodeMaps.server'),
};
const mod = async (n: string) => MODS[n]!();
const reject = async (p: Promise<unknown>, status: number, code: string) => { await expect(p).rejects.toMatchObject({ status, problem: { code } }); expect(seen).toHaveLength(0); };
const rejects400 = (p: Promise<unknown>) => reject(p, 400, 'common.validation_failed');
/** Either rejected before any call, or sent with only the keys in `allowed` — never forwarded as-is. */
const droppedOrRejected = async (p: Promise<unknown>, allowed: string[], forbidden: string[]) => {
  const r = await p.then(() => 'sent', () => 'rejected');
  if (r === 'sent') { for (const k of Object.keys(seen[0]!.body)) expect(allowed, k).toContain(k); for (const k of forbidden) expect(seen[0]!.body).not.toHaveProperty(k); } else expect(seen).toHaveLength(0);
};

describe('#92 listInstrumentCodeMaps (AC-17.1)', () => {
  it('GET /v1/catalog/instrument-code-maps?instrument_id=… with the bearer token; returns the page', async () => {
    const { listInstrumentCodeMaps } = await mod('listInstrumentCodeMaps');
    const r = await listInstrumentCodeMaps(INST);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/instrument-code-maps');
    expect(seen[0]!.url.searchParams.get('instrument_id')).toBe(INST);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(r.data[0]).toMatchObject({ id: MAP, instrument_code: 'HGB', version: 3 });
  });

  it('passes direction / analyte_id / is_active filters through as query parameters', async () => {
    const { listInstrumentCodeMaps } = await mod('listInstrumentCodeMaps');
    await listInstrumentCodeMaps(INST, { direction: 'inbound', analyteId: ANALYTE, isActive: false });
    const q = seen[0]!.url.searchParams;
    expect([q.get('direction'), q.get('analyte_id'), q.get('is_active')]).toEqual(['inbound', ANALYTE, 'false']);
  });

  it.each([['not-a-uuid'], [''], ['../../x'], [`${INST}&instrument_id=${INST}`]])('instrument id %j → 400 before any network call (never built into a query from free text)', async (id) => {
    const { listInstrumentCodeMaps } = await mod('listInstrumentCodeMaps');
    await rejects400(listInstrumentCodeMaps(id as never));
  });

  it('bad filter values → 400 before any network call', async () => {
    const { listInstrumentCodeMaps } = await mod('listInstrumentCodeMaps');
    await rejects400(listInstrumentCodeMaps(INST, { direction: 'sideways' } as never));
    await rejects400(listInstrumentCodeMaps(INST, { analyteId: 'x' } as never));
  });

  it('C3 errors propagate as ApiError (not swallowed)', async () => {
    server.use(http.get(MAPS, () => problem(403, 'auth.mfa_required')));
    const { listInstrumentCodeMaps } = await mod('listInstrumentCodeMaps');
    await expect(listInstrumentCodeMaps(INST)).rejects.toMatchObject({ status: 403, problem: { code: 'auth.mfa_required' } });
  });
});

describe('E32 listObservedInstrumentCodes (AC-17.1)', () => {
  it('GET …/instruments/{id}/observed-codes with the bearer token; filters become record_class / mapping_status / limit / cursor', async () => {
    const { listObservedInstrumentCodes } = await mod('listObservedInstrumentCodes');
    await listObservedInstrumentCodes(INST, { recordClass: 'qc', mappingStatus: 'unmapped', limit: 100, cursor: 'c1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.pathname).toBe(`/v1/instruments/instruments/${INST}/observed-codes`);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    const q = seen[0]!.url.searchParams;
    expect([q.get('record_class'), q.get('mapping_status'), q.get('limit'), q.get('cursor')]).toEqual(['qc', 'unmapped', '100', 'c1']);
  });

  it('needs only the read permission — it is an instruments (C7) operation, not a C3 one', async () => {
    session.permissions = READ;
    const { listObservedInstrumentCodes } = await mod('listObservedInstrumentCodes');
    await listObservedInstrumentCodes(INST);
    expect(seen).toHaveLength(1);
  });

  it.each([['not-a-uuid'], ['']])('instrument id %j → 400 before any network call', async (id) => {
    const { listObservedInstrumentCodes } = await mod('listObservedInstrumentCodes');
    await rejects400(listObservedInstrumentCodes(id as never));
  });

  it.each([[{ recordClass: 'patient2' }], [{ mappingStatus: 'maybe' }], [{ limit: 0 }], [{ limit: 1.5 }], [{ limit: 100000 }]])('bad filter %j → 400 before any network call', async (q) => {
    const { listObservedInstrumentCodes } = await mod('listObservedInstrumentCodes');
    await rejects400(listObservedInstrumentCodes(INST, q as never));
  });

  it('404 propagates', async () => {
    server.use(http.get(OBS, () => problem(404, 'common.not_found')));
    const { listObservedInstrumentCodes } = await mod('listObservedInstrumentCodes');
    await expect(listObservedInstrumentCodes(INST)).rejects.toMatchObject({ status: 404 });
  });
});

describe('#93 createInstrumentCodeMap (AC-17.2)', () => {
  const load = async () => (await mod('createInstrumentCodeMap')).createInstrumentCodeMap;

  it('POST with Idempotency-Key and exactly {instrument_id, direction, instrument_code, analyte_id, test_id}; returns the created row', async () => {
    const create = await load();
    const r = await create(input(), KEY);
    expect(seen).toHaveLength(1);
    const c = seen[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/catalog/instrument-code-maps');
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.headers.get('content-type')).toMatch(/application\/json/);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.body).toEqual(input());
    expect(c.headers.get('if-match')).toBeNull(); // a create has no existing resource
    expect(r).toMatchObject({ id: MAP, version: 1 });
  });

  it('carries the optional unit conversion (all three) and flag_map when given', async () => {
    const create = await load();
    const extra = { unit_from_raw: 'g/L', unit_to_code: 'g/dL', unit_factor: '0.1', flag_map: JSON.stringify({ H: 'HIGH', L: 'LOW' }) };
    await create(input(extra), KEY);
    expect(seen[0]!.body).toEqual(input(extra));
  });

  it.each([['inbound'], ['outbound'], ['both']])('direction %s is accepted', async (d) => {
    const create = await load();
    await create(input({ direction: d }), KEY);
    expect(seen[0]!.body.direction).toBe(d);
  });

  it('boundaries accepted: instrument_code 64 chars, flag_map 20 entries with 16-char keys and 64-char values, unit_factor 6 decimals', async () => {
    const create = await load();
    const flag_map = JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`K${String(i).padStart(2, '0')}`.padEnd(16, 'x'), 'v'.repeat(64)])));
    await create(input({ instrument_code: 'A'.repeat(64), flag_map, unit_from_raw: 'x'.repeat(32), unit_to_code: 'g/dL', unit_factor: '0.000001' }), KEY);
    expect(seen).toHaveLength(1);
  });

  it.each([
    ['direction', 'sideways'], ['direction', ''], ['direction', undefined],
    ['instrument_code', ''], ['instrument_code', 'A'.repeat(65)], ['instrument_code', 42], ['instrument_code', undefined],
    ['instrument_id', 'x'], ['analyte_id', 'x'], ['analyte_id', undefined], ['test_id', 'x'], ['test_id', undefined],
    ['unit_from_raw', 'x'.repeat(33)],
  ])('invalid %s=%j → 400 before any network call', async (k, v) => {
    const create = await load();
    await rejects400(create(input({ [k as string]: v }) as never, KEY));
  });

  it.each([
    [{ unit_from_raw: 'g/L' }], [{ unit_to_code: 'g/dL' }], [{ unit_factor: '0.1' }],
    [{ unit_from_raw: 'g/L', unit_to_code: 'g/dL' }], [{ unit_from_raw: 'g/L', unit_factor: '0.1' }], [{ unit_to_code: 'g/dL', unit_factor: '0.1' }],
  ])('unit conversion is all three or none: %j → 400 before any network call', async (u) => {
    const create = await load();
    await rejects400(create(input(u) as never, KEY));
  });

  it.each([['0'], ['0.0'], ['-1'], ['0.0000001'], ['abc'], ['1e3'], [''], [' 1'], [0.1], [1], [null]])('unit_factor %j (not a positive DecimalString with ≤ 6 decimals) → 400 before any network call', async (f) => {
    const create = await load();
    await rejects400(create(input({ unit_from_raw: 'g/L', unit_to_code: 'g/dL', unit_factor: f }) as never, KEY));
  });

  it.each([['10'], ['0.1'], ['1.500000'], ['123456']])('unit_factor %s is accepted', async (f) => {
    const create = await load();
    await create(input({ unit_from_raw: 'g/L', unit_to_code: 'g/dL', unit_factor: f }), KEY);
    expect(seen[0]!.body.unit_factor).toBe(f);
  });

  it('flag_map limits (JSON object text, limits on the parsed form): 21 entries / key > 16 chars / value > 64 chars / array / non-string value / text > 2000 chars / non-JSON → 400 before any network call', async () => {
    const create = await load();
    await rejects400(create(input({ flag_map: JSON.stringify(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']))) }) as never, KEY));
    await rejects400(create(input({ flag_map: JSON.stringify({ ['k'.repeat(17)]: 'v' }) }) as never, KEY));
    await rejects400(create(input({ flag_map: JSON.stringify({ k: 'v'.repeat(65) }) }) as never, KEY));
    await rejects400(create(input({ flag_map: JSON.stringify(['H']) }) as never, KEY));
    await rejects400(create(input({ flag_map: JSON.stringify({ k: 5 }) }) as never, KEY));
    await rejects400(create(input({ flag_map: JSON.stringify({ k: 'v', pad: ' '.repeat(2000) }) }) as never, KEY));
    await rejects400(create(input({ flag_map: 'x'.repeat(2001) }) as never, KEY));
    await rejects400(create(input({ flag_map: 'not json' }) as never, KEY));
  });

  it('missing / blank Idempotency-Key → 400 before any network call (a retry must not double-create)', async () => {
    const create = await load();
    await rejects400(create(input() as never, '' as never));
    await rejects400(create(input() as never, undefined as never));
  });

  it('SECURITY: server-owned keys (id, version, tenant_id) and prototype pollution are never forwarded', async () => {
    const create = await load();
    await droppedOrRejected(create(input({ id: MAP, version: 9, tenant_id: 'other', __proto__: { x: 1 } }) as never, KEY), Object.keys(input()), ['id', 'version', 'tenant_id', 'x']);
  });

  it.each([[409, 'catalog.code_duplicate'], [400, 'common.validation_failed'], [403, 'auth.mfa_required'], [403, 'auth.forbidden'], [500, 'common.internal']])('C3 %s %s propagates as ApiError with its code', async (status, code) => {
    server.use(http.post(MAPS, () => problem(status, code)));
    const create = await load();
    await expect(create(input(), KEY)).rejects.toMatchObject({ status, problem: { code } });
  });
});

describe('#94 updateInstrumentCodeMap (edit / deactivate)', () => {
  const load = async () => (await mod('updateInstrumentCodeMap')).updateInstrumentCodeMap;

  it('PATCH /{map_id} with If-Match "<version>" and only the changed mutable fields', async () => {
    const update = await load();
    const r = await update(MAP, 3, { unit_from_raw: 'g/L', unit_to_code: 'g/dL', unit_factor: '0.1', flag_map: JSON.stringify({ H: 'HIGH' }) });
    expect(seen).toHaveLength(1);
    const c = seen[0]!;
    expect(c.method).toBe('PATCH');
    expect(c.url.pathname).toBe(`/v1/catalog/instrument-code-maps/${MAP}`);
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.body).toEqual({ unit_from_raw: 'g/L', unit_to_code: 'g/dL', unit_factor: '0.1', flag_map: JSON.stringify({ H: 'HIGH' }) });
    expect(r.version).toBe(4);
  });

  it('deactivate = PATCH {is_active:false} (nothing else)', async () => {
    const update = await load();
    await update(MAP, 3, { is_active: false });
    expect(seen[0]!.body).toEqual({ is_active: false });
    expect(seen[0]!.headers.get('if-match')).toBe('"3"');
  });

  it('unset[] clears optional fields (e.g. removing the unit conversion)', async () => {
    const update = await load();
    await update(MAP, 3, { unset: ['unit_from_raw', 'unit_to_code', 'unit_factor'] });
    expect(seen[0]!.body).toEqual({ unset: ['unit_from_raw', 'unit_to_code', 'unit_factor'] });
  });

  it.each([['unset', ['instrument_code']], ['unset', ['analyte_id']], ['unset', 'unit_factor'], ['unset', ['bogus']], ['is_active', 'false'], ['is_active', 0],
    ['unit_factor', '0'], ['unit_factor', '1e3'], ['unit_from_raw', 'x'.repeat(33)], ['flag_map', ['H']]])('invalid %s=%j → 400 before any network call', async (k, v) => {
    const update = await load();
    await rejects400(update(MAP, 3, { [k as string]: v } as never));
  });

  it('empty patch → 400 before any network call', async () => {
    const update = await load();
    await rejects400(update(MAP, 3, {} as never));
  });

  it.each([[0], [-1], [1.5], [Number.NaN], ['3']])('invalid version %j → 400 before any network call (never "NaN" in If-Match)', async (v) => {
    const update = await load();
    await rejects400(update(MAP, v as never, { is_active: false }));
  });

  it.each([['not-a-uuid'], ['../x'], ['']])('map id %j → 400 before any network call (never builds a path from free text)', async (id) => {
    const update = await load();
    await rejects400(update(id, 3, { is_active: false }));
  });

  it('immutable fields (instrument_id, instrument_code, analyte_id; also test_id, direction) are never forwarded — deactivate + create instead', async () => {
    const update = await load();
    await droppedOrRejected(update(MAP, 3, { is_active: false, instrument_id: INST, instrument_code: 'X', analyte_id: ANALYTE, test_id: TEST, direction: 'inbound', id: MAP, version: 9 } as never),
      ['unit_from_raw', 'unit_to_code', 'unit_factor', 'flag_map', 'unset', 'is_active'], ['instrument_id', 'instrument_code', 'analyte_id', 'test_id', 'direction', 'id', 'version']);
  });

  it.each([[409, 'catalog.code_duplicate'], [409, 'common.version_conflict'], [428, 'common.precondition_required'], [403, 'auth.mfa_required'], [404, 'common.not_found']])('C3 %s %s propagates as ApiError with its code', async (status, code) => {
    server.use(http.patch(`${MAPS}/:id`, () => problem(status, code)));
    const update = await load();
    await expect(update(MAP, 3, { is_active: false })).rejects.toMatchObject({ status, problem: { code } });
  });
});

describe('#95 upsertInstrumentCodeMaps (Copy from instrument…)', () => {
  const load = async () => (await mod('upsertInstrumentCodeMaps')).upsertInstrumentCodeMaps;
  const item = (o: Record<string, unknown> = {}) => { const { instrument_id: _i, ...r } = input(o); return r; };

  it('POST /bulk-upsert with Idempotency-Key and {instrument_id, maps[]}; returns the per-row results', async () => {
    const upsert = await load();
    const maps = [item(), item({ instrument_code: 'WBC', direction: 'inbound', unit_from_raw: 'x', unit_to_code: 'y', unit_factor: '2', flag_map: JSON.stringify({ H: 'HIGH' }) })];
    const r = await upsert(INST, maps, KEY);
    expect(seen).toHaveLength(1);
    const c = seen[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/catalog/instrument-code-maps/bulk-upsert');
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.headers.get('if-match')).toBeNull();
    expect(c.body).toEqual({ instrument_id: INST, maps });
    expect(r.results[0]).toMatchObject({ outcome: 'created' });
  });

  it('200 rows is the maximum (1–200)', async () => {
    const upsert = await load();
    await upsert(INST, Array.from({ length: 200 }, (_, i) => item({ instrument_code: `C${i}` })), KEY);
    expect(seen).toHaveLength(1);
  });

  it('0 rows / 201 rows → 400 before any network call', async () => {
    const upsert = await load();
    await rejects400(upsert(INST, [], KEY));
    await rejects400(upsert(INST, Array.from({ length: 201 }, (_, i) => item({ instrument_code: `C${i}` })), KEY));
  });

  it('a row failing the create rules (bad direction, partial unit trio, 65-char code) → 400 before any network call', async () => {
    const upsert = await load();
    await rejects400(upsert(INST, [item({ direction: 'sideways' })], KEY));
    await rejects400(upsert(INST, [item({ unit_factor: '0.1' })], KEY));
    await rejects400(upsert(INST, [item({ instrument_code: 'A'.repeat(65) })], KEY));
  });

  it('bad instrument id or missing Idempotency-Key → 400 before any network call', async () => {
    const upsert = await load();
    await rejects400(upsert('nope', [item()], KEY));
    await rejects400(upsert(INST, [item()], '' as never));
  });

  it('SECURITY: a row cannot redirect itself to another instrument or smuggle id/version/is_active — only the envelope instrument_id is sent', async () => {
    const upsert = await load();
    const other = '01a1a98a-ac40-7000-8000-0000000e0999';
    await droppedOrRejected(upsert(INST, [{ ...item(), instrument_id: other, id: MAP, version: 9, is_active: false } as never], KEY), ['instrument_id', 'maps'], []);
    if (seen[0]) {
      expect(seen[0].body.instrument_id).toBe(INST);
      expect(JSON.stringify(seen[0].body.maps)).not.toContain(other);
      expect(seen[0].body.maps[0]).not.toHaveProperty('id');
      expect(seen[0].body.maps[0]).not.toHaveProperty('version');
    }
  });

  it('C3 errors propagate (403 auth.mfa_required, 500)', async () => {
    const upsert = await load();
    server.use(http.post(`${MAPS}/bulk-upsert`, () => problem(403, 'auth.mfa_required')));
    await expect(upsert(INST, [item()], KEY)).rejects.toMatchObject({ status: 403, problem: { code: 'auth.mfa_required' } });
  });
});

describe('D-39 / S-04: without `catalog.instrument_code_map.manage` the BFF makes NO C3 code-map call', () => {
  const calls = {
    list: async () => (await mod('listInstrumentCodeMaps')).listInstrumentCodeMaps(INST),
    create: async () => (await mod('createInstrumentCodeMap')).createInstrumentCodeMap(input(), KEY),
    update: async () => (await mod('updateInstrumentCodeMap')).updateInstrumentCodeMap(MAP, 3, { is_active: false }),
    upsert: async () => (await mod('upsertInstrumentCodeMaps')).upsertInstrumentCodeMaps(INST, [{ direction: 'both', instrument_code: 'HGB', analyte_id: ANALYTE, test_id: TEST }], KEY),
  } as const;

  it.each(Object.keys(calls))('%s with only instruments.instrument.read → ApiError 403 auth.forbidden, zero requests', async (k) => {
    session.permissions = READ;
    await reject((calls as any)[k](), 403, 'auth.forbidden');
  });

  it.each(Object.keys(calls))('%s with no session at all → 403, zero requests', async (k) => {
    session.permissions = undefined;
    await reject((calls as any)[k](), 403, 'auth.forbidden');
  });

  it.each(Object.keys(calls))('%s with unrelated catalog permissions (catalog.test.manage) → 403, zero requests (no permission-prefix confusion)', async (k) => {
    session.permissions = ['instruments.instrument.read', 'catalog.test.manage', 'catalog.instrument_code_map.read', 'instruments.instrument.manage'];
    await reject((calls as any)[k](), 403, 'auth.forbidden');
  });

  it.each(Object.keys(calls))('%s with manage works', async (k) => {
    await (calls as any)[k]();
    expect(seen).toHaveLength(1);
  });
});

describe('server actions (ApiError → { ok:false, status, code, errors? })', () => {
  const load = async () => import('../server/actions');

  it('createInstrumentCodeMapAction success → { ok:true, data } carrying the new id and version', async () => {
    const a = await load();
    const r = await a.createInstrumentCodeMapAction(input() as never, KEY);
    expect(r).toMatchObject({ ok: true, data: { id: MAP, version: 1 } });
    expect(seen[0]!.headers.get('idempotency-key')).toBe(KEY);
  });

  it.each([[409, 'catalog.code_duplicate'], [403, 'auth.mfa_required'], [500, 'common.internal']])('createInstrumentCodeMapAction maps %s %s', async (status, code) => {
    server.use(http.post(MAPS, () => problem(status, code)));
    const a = await load();
    expect(await a.createInstrumentCodeMapAction(input() as never, KEY)).toMatchObject({ ok: false, status, code });
  });

  it('400 keeps the errors[] JSON-Pointer paths for field mapping', async () => {
    server.use(http.post(MAPS, () => problem(400, 'common.validation_failed', { errors: [{ path: '/unit_factor', code: 'range', message: 'Factor must be greater than 0.' }] })));
    const a = await load();
    expect(await a.createInstrumentCodeMapAction(input() as never, KEY)).toMatchObject({ ok: false, status: 400, code: 'common.validation_failed', errors: [{ path: '/unit_factor' }] });
  });

  it('updateInstrumentCodeMapAction success → { ok:true, data:{ version } }; 409 version_conflict → { ok:false }', async () => {
    const a = await load();
    expect(await a.updateInstrumentCodeMapAction(MAP, 3, { is_active: false })).toMatchObject({ ok: true, data: { version: 4 } });
    server.use(http.patch(`${MAPS}/:id`, () => problem(409, 'common.version_conflict')));
    expect(await a.updateInstrumentCodeMapAction(MAP, 3, { is_active: false })).toMatchObject({ ok: false, status: 409, code: 'common.version_conflict' });
  });

  it('upsertInstrumentCodeMapsAction success → { ok:true, data:{ results } }; 403 mfa → { ok:false }', async () => {
    const a = await load();
    const maps = [{ direction: 'both', instrument_code: 'HGB', analyte_id: ANALYTE, test_id: TEST }];
    expect(await a.upsertInstrumentCodeMapsAction(INST, maps as never, KEY)).toMatchObject({ ok: true, data: { results: [{ outcome: 'created' }] } });
    server.use(http.post(`${MAPS}/bulk-upsert`, () => problem(403, 'auth.mfa_required')));
    expect(await a.upsertInstrumentCodeMapsAction(INST, maps as never, KEY)).toMatchObject({ ok: false, status: 403, code: 'auth.mfa_required' });
  });

  it('actions without manage → { ok:false, status:403, code:"auth.forbidden" } and zero requests (S-04)', async () => {
    session.permissions = READ;
    const a = await load();
    expect(await a.createInstrumentCodeMapAction(input() as never, KEY)).toMatchObject({ ok: false, status: 403, code: 'auth.forbidden' });
    expect(await a.updateInstrumentCodeMapAction(MAP, 3, { is_active: false })).toMatchObject({ ok: false, status: 403, code: 'auth.forbidden' });
    expect(await a.upsertInstrumentCodeMapsAction(INST, [{ direction: 'both', instrument_code: 'HGB', analyte_id: ANALYTE, test_id: TEST }] as never, KEY)).toMatchObject({ ok: false, status: 403, code: 'auth.forbidden' });
    expect(seen).toHaveLength(0);
  });
});

describe('static guards on the WEB-T04 files (REQ-SEC-068: browser holds no JWT/API origin; C7 never writes catalog.* directly)', () => {
  const WEB = async () => (await import('node:path')).join(import.meta.dirname, '..', '..', '..', '..');
  const read = async (rel: string) => (await import('node:fs')).readFileSync((await import('node:path')).join(await WEB(), rel), 'utf8');
  const exists = async (rel: string) => (await import('node:fs')).existsSync((await import('node:path')).join(await WEB(), rel));

  it('new server fns start with the "server-only" guard', async () => {
    for (const n of ['listInstrumentCodeMaps', 'listObservedInstrumentCodes', 'createInstrumentCodeMap', 'updateInstrumentCodeMap', 'upsertInstrumentCodeMaps']) {
      const p = `src/features/instruments/server/${n}.server.ts`;
      expect(await exists(p), n).toBe(true);
      expect(await read(p), n).toMatch(/^(\s*\/\/[^\n]*\n|\s*'use server';?\s*\n)*\s*import ['"]server-only['"]/);
    }
  });

  it('the mappings component never mentions the API origin, bearer tokens, API paths or persistence; no dangerouslySetInnerHTML', async () => {
    const p = 'src/features/instruments/components/InstrumentMappings.tsx';
    expect(await exists(p)).toBe(true);
    expect(await read(p)).not.toMatch(/LIMS_ORIGIN_API|authorization|Bearer |localStorage|sessionStorage|document\.cookie|dangerouslySetInnerHTML|\/v1\//i);
  });

  it('mappings page exists as a server component (no "use client")', async () => {
    const p = 'src/app/(staff)/instruments/instruments/[instrument_id]/mappings/page.tsx';
    expect(await exists(p)).toBe(true);
    expect(await read(p)).not.toMatch(/^\s*['"]use client['"]/);
  });

  it('the page and component never reference C3 operations other than through the BFF server/ folder', async () => {
    const page = await read('src/app/(staff)/instruments/instruments/[instrument_id]/mappings/page.tsx');
    expect(page).not.toMatch(/serverFetch|fetch\(/);
  });
});
