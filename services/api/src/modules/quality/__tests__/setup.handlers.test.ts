// C9 T-06 — HTTP wiring of #1-#13 (02-TRD §5.1/§5.2; contracts/openapi/quality.yaml). The setup SERVICE is mocked (behaviour: setup.service.test.ts): these tests fix
// req -> service input mapping, status codes, ETag, If-Match handling, fail-closed behaviour, and the idempotency / If-Match / permission flags the core pipeline enforces from the contract.
// Request shapes as delivered by the core pipeline after schema validation: params {material_id, level_id, lot_id, map_id}; query already typed (is_active boolean, limit integer);
// headers lower-case; body parsed JSON. hctx = service ctx + operationId/clientIp/log.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { INS, LOT, LVL, MAP, MAT, OPS, makeCtx, rejection, type Row } from './setup.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/setup.service.js', () => ({ createSetupService: () => svc }));
// Phase switch (02-TRD:120, :806): the flag is read once at module load (handlers/index.ts), so enable it BEFORE the import.
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makeCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s has a real handler: no context -> auth.unauthenticated (the T-01 stub answers 501/common.internal), service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input in code/message/details', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['getControlMaterial']!.mockRejectedValueOnce(Object.assign(new Error('common.not_found'), { code: 'common.not_found' }));
    const e = await rejection(h('getControlMaterial')(req({ params: { material_id: planted }, headers: { authorization: planted } }), hctx('getControlMaterial')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
  it('service errors propagate untouched (quality.code_duplicate, quality.lot_expired)', async () => {
    for (const c of ['quality.code_duplicate', 'quality.lot_expired']) {
      svc['createControlLot']!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
      await expect(h('createControlLot')(req({ params: { level_id: LVL(1) }, body: { lot_no: 'L', expires_on: '2027-01-01' } }), hctx('createControlLot'))).rejects.toMatchObject({ code: c });
    }
  });
});

describe('phase switch off (ruling C9.T-06)', () => {
  it('LIMS_QUALITY_ENABLED=false: a #1-#13 op rejects common.feature_disabled and the service is not called', async () => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try {
      const off: any = (await import('../index.js')).manifest;
      const e = await rejection(off.handlers['listControlMaterials'](req(), hctx('listControlMaterials')));
      expect(e?.code).toBe('common.feature_disabled'); expect(svc['listControlMaterials']).not.toHaveBeenCalled();
    } finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('reads: request -> service mapping; 200 body passthrough; lists have no ETag', () => {
  it('#1 listControlMaterials: query -> {isActive,q,sort,cursor,limit}', async () => {
    const r = await h('listControlMaterials')(req({ query: { is_active: false, q: 'MCS', sort: '-created_at', cursor: 'C1', limit: 25 } }), hctx('listControlMaterials'));
    expect(svc['listControlMaterials']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { isActive: false, q: 'MCS', sort: '-created_at', cursor: 'C1', limit: 25 });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('#1 with no query: every filter reaches the service as undefined (the service owns the defaults)', async () => {
    await h('listControlMaterials')(req(), hctx('listControlMaterials'));
    expect(svc['listControlMaterials']).toHaveBeenCalledWith(expect.anything(), { isActive: undefined, q: undefined, sort: undefined, cursor: undefined, limit: undefined });
  });
  it('#3 getControlMaterial: 200 + ETag "<version>"', async () => {
    const r = await h('getControlMaterial')(req({ params: { material_id: MAT(1) } }), hctx('getControlMaterial'));
    expect(svc['getControlMaterial']).toHaveBeenCalledWith(expect.anything(), { materialId: MAT(1) }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('#9 listControlLots: query -> {materialId,levelId,isActive,expiresOnTo,sort,cursor,limit}', async () => {
    const r = await h('listControlLots')(req({ query: { material_id: MAT(1), level_id: LVL(2), is_active: true, expires_on_to: '2027-01-01', sort: 'expires_on', cursor: 'C', limit: 10 } }), hctx('listControlLots'));
    expect(svc['listControlLots']).toHaveBeenCalledWith(expect.anything(), { materialId: MAT(1), levelId: LVL(2), isActive: true, expiresOnTo: '2027-01-01', sort: 'expires_on', cursor: 'C', limit: 10 });
    expect(r.headers?.etag).toBeUndefined();
  });
  it('#11 listControlIdMaps: query -> {instrumentId,lotId,isActive,cursor,limit}', async () => {
    const r = await h('listControlIdMaps')(req({ query: { instrument_id: INS(1), lot_id: LOT(1), is_active: true, cursor: 'C', limit: 5 } }), hctx('listControlIdMaps'));
    expect(svc['listControlIdMaps']).toHaveBeenCalledWith(expect.anything(), { instrumentId: INS(1), lotId: LOT(1), isActive: true, cursor: 'C', limit: 5 }); expect(r.headers?.etag).toBeUndefined();
  });
});

describe('creates: 201 + ETag of the new version; body passed unchanged (the service validates it)', () => {
  const created = (op: string) => svc[op]!.mockResolvedValueOnce({ status: 201, body: { id: MAT(1) }, version: 1 });
  it('#2 createControlMaterial', async () => {
    created('createControlMaterial'); const body = { code: 'MCS-SYN', name: 'n', levels: [{ level_code: '1', display_name: 'L1', sort_order: 1 }] };
    const r = await h('createControlMaterial')(req({ body }), hctx('createControlMaterial'));
    expect(svc['createControlMaterial']).toHaveBeenCalledWith(expect.anything(), { body }); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('#6 createControlLevel: path material_id + body', async () => {
    created('createControlLevel'); const body = { level_code: '3', display_name: 'L3', sort_order: 3 };
    const r = await h('createControlLevel')(req({ params: { material_id: MAT(1) }, body }), hctx('createControlLevel'));
    expect(svc['createControlLevel']).toHaveBeenCalledWith(expect.anything(), { materialId: MAT(1), body }); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('#8 createControlLot: path level_id + body', async () => {
    created('createControlLot'); const body = { lot_no: 'LOT-SYN-01', expires_on: '2027-03-31' };
    const r = await h('createControlLot')(req({ params: { level_id: LVL(1) }, body }), hctx('createControlLot'));
    expect(svc['createControlLot']).toHaveBeenCalledWith(expect.anything(), { levelId: LVL(1), body }); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('#12 createControlIdMap: body', async () => {
    created('createControlIdMap'); const body = { instrument_id: INS(1), control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-01', lot_id: LOT(1) };
    const r = await h('createControlIdMap')(req({ body }), hctx('createControlIdMap'));
    expect(svc['createControlIdMap']).toHaveBeenCalledWith(expect.anything(), { body }); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('tenant_id / created_by in a path, query or header never reach the service input', async () => {
    created('createControlMaterial'); await h('createControlMaterial')(req({ query: { tenant_id: 'T' }, headers: { 'x-tenant-id': 'T' }, body: { code: 'AB' } }), hctx('createControlMaterial'));
    expect(JSON.stringify(svc['createControlMaterial']!.mock.calls[0]![1])).not.toMatch(/"T"|tenant/);
  });
});

describe('If-Match writes: header -> expectedVersion; 200 + ETag of the new version', () => {
  const cases: Array<[string, object, object, Row]> = [
    ['updateControlMaterial', { material_id: MAT(1) }, { name: 'N', unset: ['matrix'] }, { materialId: MAT(1), patch: { name: 'N', unset: ['matrix'] } }],
    ['deactivateControlMaterial', { material_id: MAT(1) }, {}, { materialId: MAT(1) }],
    ['updateControlLevel', { level_id: LVL(1) }, { display_name: 'x', sort_order: 2, is_active: false }, { levelId: LVL(1), patch: { display_name: 'x', sort_order: 2, is_active: false } }],
    ['updateControlLot', { lot_id: LOT(1) }, { expires_on: '2028-01-31', is_active: true }, { lotId: LOT(1), patch: { expires_on: '2028-01-31', is_active: true } }],
    ['deactivateControlIdMap', { map_id: MAP(1) }, {}, { mapId: MAP(1) }],
  ];
  it.each(cases)('%s: If-Match + path + body -> service; 200 + ETag', async (op, params, body, input) => {
    const r = await h(op)(req({ params, headers: ifm(2), body }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { ...input, expectedVersion: 2 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(cases)('%s: absent header -> service gets expectedVersion undefined (it answers 428)', async (op, params, body) => {
    await h(op)(req({ params, body }), hctx(op)); expect(svc[op]).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: undefined }));
  });
  it.each(cases)('%s: malformed header (W/"1", 1, "0", "01", "1x", "") -> 400 common.validation_failed, service not called', async (op, params, body) => {
    for (const v of ['W/"1"', '1', '"0"', '"01"', '"1x"', '""']) expect((await rejection(h(op)(req({ params, headers: { 'if-match': v }, body }), hctx(op))))?.code, v).toBe('common.validation_failed');
    expect(svc[op]).not.toHaveBeenCalled();
  });
});

describe('contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.0)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const op = (id: string) => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === id) return { path, method, o }; throw new Error(`no ${id}`); };
  // [operationId, x-permission, x-idempotency, takes If-Match, extra error codes]
  const T: Array<[string, string, string, boolean, string[]]> = [
    ['listControlMaterials', 'quality.qc_run.read', 'none', false, ['common.invalid_cursor']], ['createControlMaterial', 'quality.qc.manage', 'required', false, ['quality.code_duplicate']],
    ['getControlMaterial', 'quality.qc_run.read', 'none', false, []], ['updateControlMaterial', 'quality.qc.manage', 'none', true, []], ['deactivateControlMaterial', 'quality.qc.manage', 'optional', true, []],
    ['createControlLevel', 'quality.qc.manage', 'required', false, ['quality.code_duplicate']], ['updateControlLevel', 'quality.qc.manage', 'none', true, []],
    ['createControlLot', 'quality.qc.manage', 'required', false, ['quality.code_duplicate', 'quality.lot_expired']], ['listControlLots', 'quality.qc_run.read', 'none', false, []],
    ['updateControlLot', 'quality.qc.manage', 'none', true, ['quality.lot_expired']], ['listControlIdMaps', 'quality.qc_run.read', 'none', false, []],
    ['createControlIdMap', 'quality.qc.manage', 'required', false, ['quality.code_duplicate', 'quality.lot_expired', 'common.validation_failed']], ['deactivateControlIdMap', 'quality.qc.manage', 'optional', true, []],
  ];
  it('the table covers exactly #1-#13', () => { expect(T.map((t) => t[0]).sort()).toEqual([...OPS].sort()); });
  it.each(T)('%s: permission, idempotency, If-Match, error codes', (id, perm, idem, ifMatch, extra) => {
    const { o } = op(id); expect(o['x-permission']).toBe(perm); expect(o['x-idempotency'] ?? 'none').toBe(idem);
    expect(JSON.stringify(o.parameters ?? []).includes('IfMatch')).toBe(ifMatch);
    expect(o['x-error-codes']).toEqual(expect.arrayContaining(extra));
    if (ifMatch) expect(o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
    if (idem === 'required') expect(o['x-error-codes']).toEqual(expect.arrayContaining(['common.idempotency_key_required', 'common.idempotency_key_reused', 'common.idempotency_in_progress']));
  });
  it('the handler map has an entry for every one of the 13 operationIds and each is a function', () => { for (const id of OPS) expect(typeof h(id), id).toBe('function'); });
});
