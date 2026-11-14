// C9 T-08 — HTTP wiring of #20-#25 (02-TRD §5.3; contracts/openapi/quality.yaml). The target SERVICE is mocked (behaviour: target.service.test.ts): these tests fix req -> service input
// mapping, status codes, ETag, If-Match handling, fail-closed behaviour, and the idempotency / If-Match / permission / error-code flags the core pipeline enforces from the contract.
// Request shapes as delivered by the core pipeline after schema validation: params {target_id}; query already typed; headers lower-case; body parsed JSON.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { LOT, OPS, PLN, TGT, createBody, estBody, makePlanCtx, rejection } from './target.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/target.service.js', () => ({ createTargetService: () => svc }));
// Phase switch (02-TRD:120, :806): the flag is read once at module load (handlers/index.ts), so enable it BEFORE the import.
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makePlanCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s has a real handler: no context -> auth.unauthenticated (the T-01 stub answers 501/common.internal), service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('a context without a transaction or actor is also refused (no partial context reaches the service)', async () => {
    for (const bad of [{ tenantId: 'T', actor: { id: 'U' } }, { tenantId: 'T', tx: {} }, { actor: { id: 'U' }, tx: {} }]) {
      const e = await rejection(h('activateQcTarget')(req({ params: { target_id: TGT(1) }, headers: ifm(1), body: {} }), { operationId: 'activateQcTarget', log: { info() {}, warn() {}, error() {} }, ...bad }));
      expect(e?.code).toBe('auth.unauthenticated');
    }
    expect(svc['activateQcTarget']).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input in code/message/details', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['activateQcTarget']!.mockRejectedValueOnce(Object.assign(new Error('common.not_found'), { code: 'common.not_found' }));
    const e = await rejection(h('activateQcTarget')(req({ params: { target_id: planted }, headers: { authorization: planted, ...ifm(1) }, body: {} }), hctx('activateQcTarget')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
  it('service errors propagate untouched (quality.lot_expired, quality.insufficient_qc_data, common.immutable_record, common.version_conflict)', async () => {
    for (const [op, c, extra] of [['createQcTarget', 'quality.lot_expired', {}], ['establishQcTarget', 'quality.insufficient_qc_data', {}], ['activateQcTarget', 'common.immutable_record', { headers: ifm(1) }], ['retireQcTarget', 'common.version_conflict', { headers: ifm(1) }]] as const) {
      svc[op]!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
      await expect(h(op)(req({ params: { target_id: TGT(1) }, body: {}, ...extra }), hctx(op))).rejects.toMatchObject({ code: c });
    }
  });
});

describe('phase switch off (ruling C9.T-06 extends to #20-#25)', () => {
  it('LIMS_QUALITY_ENABLED=false: every target op rejects common.feature_disabled and the service is not called', async () => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try {
      const off: any = (await import('../index.js')).manifest;
      for (const op of OPS) { const e = await rejection(off.handlers[op](req(), hctx(op))); expect(e?.code, op).toBe('common.feature_disabled'); expect(svc[op], op).not.toHaveBeenCalled(); }
    } finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('request -> service mapping', () => {
  it('#20 listQcTargets: query -> {planId,lotId,status,cursor,limit}; the status csv reaches the service as sent; 200; a list has no ETag', async () => {
    const r = await h('listQcTargets')(req({ query: { plan_id: PLN(1), lot_id: LOT(1), status: 'draft,active', cursor: 'C1', limit: 25 } }), hctx('listQcTargets'));
    expect(svc['listQcTargets']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { planId: PLN(1), lotId: LOT(1), status: 'draft,active', cursor: 'C1', limit: 25 });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined(); expect(r.body).toEqual({ ok: 'listQcTargets' });
  });
  it('#20 with no query: every filter reaches the service as undefined (the service owns the defaults)', async () => {
    await h('listQcTargets')(req(), hctx('listQcTargets')); expect(svc['listQcTargets']).toHaveBeenCalledWith(expect.anything(), { planId: undefined, lotId: undefined, status: undefined, cursor: undefined, limit: undefined });
  });
  it.each([['createQcTarget', createBody()], ['establishQcTarget', estBody()]])('#21/#22 %s: body passed unchanged (the service validates it); 201 + ETag of version 1', async (op, b) => {
    svc[op]!.mockResolvedValueOnce({ status: 201, body: { id: TGT(1) }, version: 1 });
    const r = await h(op)(req({ body: b }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { body: b }); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it.each([['createQcTarget'], ['establishQcTarget']])('%s: a dirty body (tenant_id, status, basis_n, source established) reaches the service UNCHANGED — it is rejected there, never silently dropped here', async (op) => {
    const dirty = { ...createBody({ source: 'established' }), tenant_id: 'T', status: 'active', basis_n: 25 }; svc[op]!.mockResolvedValueOnce({ status: 201, body: {}, version: 1 });
    await h(op)(req({ body: dirty }), hctx(op)); expect(svc[op]!.mock.calls[0]![1]).toMatchObject({ body: dirty });
  });
  it('tenant_id / created_by in a path, query or header never reach the service input', async () => {
    svc['createQcTarget']!.mockResolvedValueOnce({ status: 201, body: {}, version: 1 });
    await h('createQcTarget')(req({ query: { tenant_id: 'T' }, headers: { 'x-tenant-id': 'T' }, body: { plan_id: PLN(1) } }), hctx('createQcTarget'));
    expect(JSON.stringify(svc['createQcTarget']!.mock.calls[0]![1])).not.toMatch(/"T"|tenant/);
  });
});

describe('If-Match writes #23-#25: header -> expectedVersion; 200 + ETag of the new version', () => {
  const cases: Array<[string, object]> = [['activateQcTarget', { effective_from: '2026-11-20T00:00:00.000Z' }], ['retireQcTarget', { reason: 'Lot withdrawn' }], ['discardQcTarget', {}]];
  it.each(cases)('%s: If-Match + path + body -> service; 200 + ETag', async (op, b) => {
    const r = await h(op)(req({ params: { target_id: TGT(1) }, headers: ifm(2), body: b }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { targetId: TGT(1), expectedVersion: 2, body: b }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(cases)('%s: absent header -> service gets expectedVersion undefined (it answers 428)', async (op, b) => {
    await h(op)(req({ params: { target_id: TGT(1) }, body: b }), hctx(op)); expect(svc[op]).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: undefined }));
  });
  it.each(cases)('%s: malformed header (W/"1", 1, "0", "01", "1x", "") -> 400 common.validation_failed, service not called', async (op, b) => {
    for (const v of ['W/"1"', '1', '"0"', '"01"', '"1x"', '""']) expect((await rejection(h(op)(req({ params: { target_id: TGT(1) }, headers: { 'if-match': v }, body: b }), hctx(op))))?.code, v).toBe('common.validation_failed');
    expect(svc[op]).not.toHaveBeenCalled();
  });
  it.each(cases)('%s: the body is passed UNCHANGED (a smuggled mean/sd/tenant_id is rejected by the service, never silently dropped here)', async (op, b) => {
    const dirty = { ...b, mean: '1.0', sd: '9.0', tenant_id: 'T', status: 'active' }; await h(op)(req({ params: { target_id: TGT(1) }, headers: ifm(1), body: dirty }), hctx(op));
    expect(svc[op]!.mock.calls[0]![1]).toMatchObject({ body: dirty });
  });
});

describe('contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.0/§5.3)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const op = (id: string) => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === id) return { path, method, o }; throw new Error(`no ${id}`); };
  // [operationId, METHOD, path, x-permission, x-idempotency, takes If-Match, success status, extra error codes]
  const T: Array<[string, string, string, string, string, boolean, string, string[]]> = [
    ['listQcTargets', 'get', '/v1/quality/qc-targets', 'quality.qc_run.read', 'none', false, '200', ['common.invalid_cursor']],
    ['createQcTarget', 'post', '/v1/quality/qc-targets', 'quality.qc.manage', 'required', false, '201', ['quality.lot_expired', 'common.validation_failed']],
    ['establishQcTarget', 'post', '/v1/quality/qc-targets/establish', 'quality.qc.manage', 'required', false, '201', ['quality.insufficient_qc_data', 'common.validation_failed']],
    ['activateQcTarget', 'post', '/v1/quality/qc-targets/{target_id}/activate', 'quality.qc.manage', 'optional', true, '200', ['common.immutable_record']],
    ['retireQcTarget', 'post', '/v1/quality/qc-targets/{target_id}/retire', 'quality.qc.manage', 'optional', true, '200', ['common.immutable_record']],
    ['discardQcTarget', 'post', '/v1/quality/qc-targets/{target_id}/discard', 'quality.qc.manage', 'optional', true, '200', ['common.immutable_record']],
  ];
  it('the table covers exactly #20-#25', () => { expect(T.map((t) => t[0]).sort()).toEqual([...OPS].sort()); });
  it.each(T)('%s: method/path, permission, idempotency, If-Match, success status, error codes', (id, method, path, perm, idem, ifMatch, ok, extra) => {
    const r = op(id); expect(r.method).toBe(method); expect(r.path).toBe(path);
    expect(r.o['x-permission']).toBe(perm); expect(r.o['x-idempotency'] ?? 'none').toBe(idem);
    expect(JSON.stringify(r.o.parameters ?? []).includes('IfMatch')).toBe(ifMatch); expect(Object.keys(r.o.responses)).toContain(ok);
    expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(extra)); expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.feature_disabled']));
    if (ifMatch) expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
    if (idem === 'required') expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.idempotency_key_required', 'common.idempotency_key_reused', 'common.idempotency_in_progress']));
  });
  it('#21 request schema (done_when): source enum has the SINGLE value manufacturer; additionalProperties false; no tenant_id/status/level_id/basis_*/effective_* field exists', () => {
    const s = op('createQcTarget').o.requestBody.content['application/json'].schema; expect(s.additionalProperties).toBe(false);
    expect(s.properties.source.enum).toEqual(['manufacturer']); expect(Object.keys(s.properties).sort()).toEqual(['lot_id', 'mean', 'note', 'plan_id', 'sd', 'source', 'unit_code']); expect(s.required).toEqual(expect.arrayContaining(['plan_id', 'lot_id', 'mean', 'sd', 'unit_code', 'source']));
  });
  it('#22 request schema: additionalProperties false; exactly the 6 documented fields; id lists unique and <= 500; no mean/sd/source field exists', () => {
    const s = op('establishQcTarget').o.requestBody.content['application/json'].schema; expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties).sort()).toEqual(['exclude_observation_ids', 'include_observation_ids', 'lot_id', 'observed_at_from', 'observed_at_to', 'plan_id']);
    for (const k of ['include_observation_ids', 'exclude_observation_ids']) { expect(s.properties[k].maxItems).toBe(500); expect(s.properties[k].uniqueItems).toBe(true); }
  });
  it('#23 request schema: only effective_from; #24: only reason (1..500, required); #25: empty object — none can carry mean/sd', () => {
    const a = op('activateQcTarget').o.requestBody.content['application/json'].schema, r = op('retireQcTarget').o.requestBody.content['application/json'].schema, d = op('discardQcTarget').o.requestBody.content['application/json'].schema;
    expect(Object.keys(a.properties)).toEqual(['effective_from']); expect(a.additionalProperties).toBe(false); expect(Object.keys(r.properties)).toEqual(['reason']); expect(r.required).toEqual(['reason']); expect(r.properties.reason).toMatchObject({ minLength: 1, maxLength: 500 });
    expect(d.additionalProperties).toBe(false); expect(Object.keys(d.properties ?? {})).toEqual([]);
  });
  it('AC-04.6 by construction: there is NO route that edits a target (no path with {target_id} other than activate/retire/discard; no PUT/PATCH/DELETE on any /qc-targets path)', () => {
    const paths = Object.keys(doc.paths).filter((p) => p.includes('/qc-targets')); expect(paths.sort()).toEqual(['/v1/quality/qc-targets', '/v1/quality/qc-targets/establish', '/v1/quality/qc-targets/{target_id}/activate', '/v1/quality/qc-targets/{target_id}/discard', '/v1/quality/qc-targets/{target_id}/retire']);
    for (const p of paths) expect(Object.keys(doc.paths[p]).filter((m) => ['put', 'patch', 'delete'].includes(m))).toEqual([]);
  });
  it('QcTargetDto: additionalProperties false; source enum manufacturer|established; basis only has n/from/to/observation_ids_sha256 with the lowercase-hex pattern; no tenant_id / created_by / mean-writers', () => {
    const d = doc.components.schemas.QcTargetDto; expect(d.additionalProperties).toBe(false); expect(d.properties.source.enum).toEqual(['manufacturer', 'established']);
    expect(Object.keys(d.properties.basis.properties).sort()).toEqual(['from', 'n', 'observation_ids_sha256', 'to']); expect(d.properties.basis.properties.observation_ids_sha256.pattern).toBe('^[0-9a-f]{64}$');
    expect(Object.keys(d.properties)).not.toEqual(expect.arrayContaining(['tenant_id'])); expect(Object.keys(d.properties)).not.toContain('created_by');
  });
  it('the handler map has an entry for every one of the 6 operationIds and each is a function', () => { for (const id of OPS) expect(typeof h(id), id).toBe('function'); });
});
