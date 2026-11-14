// C9 T-07 — HTTP wiring of #14-#19 (02-TRD §5.3; contracts/openapi/quality.yaml). The plan SERVICE is mocked (behaviour: plan.service.test.ts): these tests fix
// req -> service input mapping, status codes, ETag, If-Match handling, fail-closed behaviour, and the idempotency / If-Match / permission / error-code flags the core pipeline enforces
// from the contract. Request shapes as delivered by the core pipeline after schema validation: params {plan_id}; query already typed; headers lower-case; body parsed JSON.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { INS, OPS, PLN, ANA, TST, makePlanCtx, params2, rejection } from './plan.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/plan.service.js', () => ({ createPlanService: () => svc }));
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
      const e = await rejection(h('getQcPlan')(req({ params: { plan_id: PLN(1) } }), { operationId: 'getQcPlan', log: { info() {}, warn() {}, error() {} }, ...bad }));
      expect(e?.code).toBe('auth.unauthenticated');
    }
    expect(svc['getQcPlan']).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input in code/message/details', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['getQcPlan']!.mockRejectedValueOnce(Object.assign(new Error('common.not_found'), { code: 'common.not_found' }));
    const e = await rejection(h('getQcPlan')(req({ params: { plan_id: planted }, headers: { authorization: planted } }), hctx('getQcPlan')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
  it('service errors propagate untouched (quality.code_duplicate, quality.qc_target_missing, common.version_conflict)', async () => {
    for (const [op, c, extra] of [['createQcPlan', 'quality.code_duplicate', {}], ['activateQcPlan', 'quality.qc_target_missing', { headers: ifm(1) }], ['createQcPlanVersion', 'common.version_conflict', { headers: ifm(1) }]] as const) {
      svc[op]!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
      await expect(h(op)(req({ params: { plan_id: PLN(1) }, body: {}, ...extra }), hctx(op))).rejects.toMatchObject({ code: c });
    }
  });
});

describe('phase switch off (ruling C9.T-06 extends to #14-#19)', () => {
  it('LIMS_QUALITY_ENABLED=false: every plan op rejects common.feature_disabled and the service is not called', async () => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try {
      const off: any = (await import('../index.js')).manifest;
      for (const op of OPS) { const e = await rejection(off.handlers[op](req(), hctx(op))); expect(e?.code, op).toBe('common.feature_disabled'); expect(svc[op], op).not.toHaveBeenCalled(); }
    } finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('request -> service mapping', () => {
  it('#14 listQcPlans: query -> {instrumentId,analyteId,status,cursor,limit}; 200; a list has no ETag', async () => {
    const r = await h('listQcPlans')(req({ query: { instrument_id: INS(1), analyte_id: ANA(1), status: 'active', cursor: 'C1', limit: 25 } }), hctx('listQcPlans'));
    expect(svc['listQcPlans']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { instrumentId: INS(1), analyteId: ANA(1), status: 'active', cursor: 'C1', limit: 25 });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined(); expect(r.body).toEqual({ ok: 'listQcPlans' });
  });
  it('#14 with no query: every filter reaches the service as undefined (the service owns the defaults)', async () => {
    await h('listQcPlans')(req(), hctx('listQcPlans'));
    expect(svc['listQcPlans']).toHaveBeenCalledWith(expect.anything(), { instrumentId: undefined, analyteId: undefined, status: undefined, cursor: undefined, limit: undefined });
  });
  it('#15 createQcPlan: body passed unchanged (the service validates it); 201 + ETag of version 1', async () => {
    svc['createQcPlan']!.mockResolvedValueOnce({ status: 201, body: { id: PLN(1) }, version: 1 });
    const b = { instrument_id: INS(1), test_id: TST(1), analyte_id: ANA(1), params: params2() };
    const r = await h('createQcPlan')(req({ body: b }), hctx('createQcPlan'));
    expect(svc['createQcPlan']).toHaveBeenCalledWith(expect.anything(), { body: b }); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('#16 getQcPlan: path plan_id -> {planId}; 200 + ETag "<version>"', async () => {
    const r = await h('getQcPlan')(req({ params: { plan_id: PLN(1) } }), hctx('getQcPlan'));
    expect(svc['getQcPlan']).toHaveBeenCalledWith(expect.anything(), { planId: PLN(1) }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('tenant_id / created_by in a path, query or header never reach the service input', async () => {
    svc['createQcPlan']!.mockResolvedValueOnce({ status: 201, body: {}, version: 1 });
    await h('createQcPlan')(req({ query: { tenant_id: 'T' }, headers: { 'x-tenant-id': 'T' }, body: { instrument_id: INS(1) } }), hctx('createQcPlan'));
    expect(JSON.stringify(svc['createQcPlan']!.mock.calls[0]![1])).not.toMatch(/"T"|tenant/);
  });
});

describe('If-Match writes #17-#19: header -> expectedVersion; 200 + ETag of the new version', () => {
  const cases: Array<[string, object, Record<string, unknown>]> = [
    ['createQcPlanVersion', { params: params2(), change_reason: 'Add level' }, { planId: PLN(1) }],
    ['activateQcPlan', {}, { planId: PLN(1) }],
    ['deactivateQcPlan', { reason: 'Out of service' }, { planId: PLN(1) }],
  ];
  it.each(cases)('%s: If-Match + path + body -> service; 200 + ETag', async (op, b, input) => {
    const r = await h(op)(req({ params: { plan_id: PLN(1) }, headers: ifm(2), body: b }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { ...input, expectedVersion: 2, body: b }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(cases)('%s: absent header -> service gets expectedVersion undefined (it answers 428)', async (op, b) => {
    await h(op)(req({ params: { plan_id: PLN(1) }, body: b }), hctx(op)); expect(svc[op]).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: undefined }));
  });
  it.each(cases)('%s: malformed header (W/"1", 1, "0", "01", "1x", "") -> 400 common.validation_failed, service not called', async (op, b) => {
    for (const v of ['W/"1"', '1', '"0"', '"01"', '"1x"', '""']) expect((await rejection(h(op)(req({ params: { plan_id: PLN(1) }, headers: { 'if-match': v }, body: b }), hctx(op))))?.code, v).toBe('common.validation_failed');
    expect(svc[op]).not.toHaveBeenCalled();
  });
  it.each(cases)('%s: the body is passed UNCHANGED (unknown fields are rejected by the service, never silently dropped here)', async (op, b) => {
    const dirty = { ...b, tenant_id: 'T', status: 'active' }; await h(op)(req({ params: { plan_id: PLN(1) }, headers: ifm(1), body: dirty }), hctx(op));
    expect(svc[op]!.mock.calls[0]![1]).toMatchObject({ body: dirty });
  });
});

describe('contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.0/§5.3)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const op = (id: string) => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === id) return { path, method, o }; throw new Error(`no ${id}`); };
  // [operationId, METHOD, path, x-permission, x-idempotency, takes If-Match, success status, extra error codes]
  const T: Array<[string, string, string, string, string, boolean, string, string[]]> = [
    ['listQcPlans', 'get', '/v1/quality/qc-plans', 'quality.qc_run.read', 'none', false, '200', ['common.invalid_cursor']],
    ['createQcPlan', 'post', '/v1/quality/qc-plans', 'quality.qc.manage', 'required', false, '201', ['quality.code_duplicate', 'common.validation_failed']],
    ['getQcPlan', 'get', '/v1/quality/qc-plans/{plan_id}', 'quality.qc_run.read', 'none', false, '200', []],
    ['createQcPlanVersion', 'post', '/v1/quality/qc-plans/{plan_id}/versions', 'quality.qc.manage', 'required', true, '200', []],
    ['activateQcPlan', 'post', '/v1/quality/qc-plans/{plan_id}/activate', 'quality.qc.manage', 'optional', true, '200', ['quality.qc_target_missing']],
    ['deactivateQcPlan', 'post', '/v1/quality/qc-plans/{plan_id}/deactivate', 'quality.qc.manage', 'optional', true, '200', []],
  ];
  it('the table covers exactly #14-#19', () => { expect(T.map((t) => t[0]).sort()).toEqual([...OPS].sort()); });
  it.each(T)('%s: method/path, permission, idempotency, If-Match, success status, error codes', (id, method, path, perm, idem, ifMatch, ok, extra) => {
    const r = op(id); expect(r.method).toBe(method); expect(r.path).toBe(path);
    expect(r.o['x-permission']).toBe(perm); expect(r.o['x-idempotency'] ?? 'none').toBe(idem);
    expect(JSON.stringify(r.o.parameters ?? []).includes('IfMatch')).toBe(ifMatch); expect(Object.keys(r.o.responses)).toContain(ok);
    expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(extra)); expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.feature_disabled']));
    if (ifMatch) expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
    if (idem === 'required') expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.idempotency_key_required', 'common.idempotency_key_reused', 'common.idempotency_in_progress']));
  });
  it('#15 request schema: additionalProperties false at body, params and composition items; controls_per_run enum [2,3,4]; no tenant_id/status field exists', () => {
    const s = op('createQcPlan').o.requestBody.content['application/json'].schema; expect(s.additionalProperties).toBe(false); expect(Object.keys(s.properties).sort()).toEqual(['analyte_id', 'instrument_id', 'params', 'test_id']);
    const p = doc.components.schemas.QcPlanParams; expect(p.additionalProperties).toBe(false); expect(p.properties.controls_per_run.enum).toEqual([2, 3, 4]); expect(p.properties.composition.items.additionalProperties).toBe(false);
    expect(Object.keys(p.properties)).not.toEqual(expect.arrayContaining(['tenant_id']));
  });
  it('#15 201 body is QcPlanDtoWithWarnings whose only warning value is instrument_code_unmapped; #16 body is QcPlanDtoWithVersions', () => {
    expect(JSON.stringify(op('createQcPlan').o.responses['201'])).toContain('QcPlanDtoWithWarnings'); expect(doc.components.schemas.QcPlanDtoWithWarnings.properties.warnings.items.enum).toEqual(['instrument_code_unmapped']);
    expect(JSON.stringify(op('getQcPlan').o.responses['200'])).toContain('QcPlanDtoWithVersions');
  });
  it('the handler map has an entry for every one of the 6 operationIds and each is a function', () => { for (const id of OPS) expect(typeof h(id), id).toBe('function'); });
});
