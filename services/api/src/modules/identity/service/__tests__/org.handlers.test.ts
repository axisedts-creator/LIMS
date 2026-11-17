// T15 HTTP wiring of the ten branch/centre operations (02-TRD §5.5; contracts/openapi/identity.yaml).
// The org SERVICE is mocked (behaviour is in org.service.test.ts): these tests fix req -> service input mapping, status codes, ETag, If-Match parsing,
// mass-assignment stripping and fail-closed behaviour. Schema validation, x-permission and Idempotency-Key are the core pipeline's.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { BR_A1, CE_A1, TENANT_A, TENANT_B, makeCtx, rejection } from './org.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listBranches', 'createBranch', 'updateBranch', 'deactivateBranch', 'reactivateBranch', 'listCentres', 'createCentre', 'updateCentre', 'deactivateCentre', 'reactivateCentre'];
vi.mock('../org.service.js', () => ({ createOrgService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makeCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s: no context -> auth.unauthenticated (the stub answers common.internal); service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input in code/message/detail', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['deactivateCentre']!.mockRejectedValueOnce(new LimsError('common.not_found'));
    const e = await rejection(h('deactivateCentre')(req({ params: { centre_id: planted }, headers: { authorization: planted, 'if-match': '"1"' } }), hctx('deactivateCentre')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
  it('service errors propagate unchanged (the core renders them)', async () => {
    svc['createCentre']!.mockRejectedValueOnce(new LimsError('identity.code_duplicate'));
    expect((await rejection(h('createCentre')(req({ body: {} }), hctx('createCentre')))).code).toBe('identity.code_duplicate');
    svc['deactivateBranch']!.mockRejectedValueOnce(new LimsError('identity.centre_inactive'));
    expect((await rejection(h('deactivateBranch')(req({ params: { branch_id: BR_A1 } }), hctx('deactivateBranch')))).code).toBe('identity.centre_inactive');
  });
});

describe('branches: request -> service mapping and responses', () => {
  it.each([[{ is_active: true }, { isActive: true }], [{ is_active: false }, { isActive: false }], [{}, {}]])('listBranches query %j -> %j; 200, no ETag', async (query, input) => {
    const r = await h('listBranches')(req({ query }), hctx('listBranches'));
    expect(svc['listBranches']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), input); expect(r.status).toBe(200); expect(r.body).toEqual({ ok: 'listBranches' }); expect(r.headers?.etag).toBeUndefined();
  });
  it('createBranch: snake_case body -> camelCase input; 201 + ETag of the new version; only known fields forwarded (mass assignment)', async () => {
    svc['createBranch']!.mockResolvedValueOnce({ status: 201, body: { branch_id: BR_A1 }, version: 1 });
    const r = await h('createBranch')(req({ body: { code: 'KTM-03', name: 'Third', address_text: 'a', phone: 'p', is_processing_lab: false, tenant_id: TENANT_B, branch_id: BR_A1, id: BR_A1, version: 9, is_active: false } }), hctx('createBranch'));
    const input = svc['createBranch']!.mock.calls[0]![1];
    expect(input).toEqual({ code: 'KTM-03', name: 'Third', addressText: 'a', phone: 'p', isProcessingLab: false });
    expect(Object.keys(input).sort()).toEqual(['addressText', 'code', 'isProcessingLab', 'name', 'phone']);
    expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('createBranch: optional fields absent -> not forwarded as keys', async () => {
    await h('createBranch')(req({ body: { code: 'K1', name: 'n' } }), hctx('createBranch'));
    expect(Object.keys(svc['createBranch']!.mock.calls[0]![1]).sort()).toEqual(['code', 'name']);
  });
  it('the tenant given to the service is the context tenant, never one from params/query/body', async () => {
    await h('createBranch')(req({ body: { tenant_id: TENANT_B, code: 'x1', name: 'n' }, query: { tenant_id: TENANT_B } }), hctx('createBranch'));
    expect(svc['createBranch']!.mock.calls[0]![0].tenantId).toBe(TENANT_A);
  });
  it('updateBranch: If-Match + body -> expectedVersion + fields; unset forwarded; code / tenant_id / is_active / version dropped; 200 + ETag', async () => {
    const r = await h('updateBranch')(req({ params: { branch_id: BR_A1 }, headers: { 'if-match': '"2"' }, body: { name: 'N', address_text: 'a', phone: 'p', is_processing_lab: true, unset: ['phone'], code: 'HIJACK', tenant_id: TENANT_B, is_active: false, version: 9 } }), hctx('updateBranch'));
    expect(svc['updateBranch']).toHaveBeenCalledWith(expect.anything(), { branchId: BR_A1, expectedVersion: 2, name: 'N', addressText: 'a', phone: 'p', isProcessingLab: true, unset: ['phone'] });
    expect(Object.keys(svc['updateBranch']!.mock.calls[0]![1]).sort()).toEqual(['addressText', 'branchId', 'expectedVersion', 'isProcessingLab', 'name', 'phone', 'unset']);
    expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(['deactivateBranch', 'reactivateBranch'])('%s: path branch_id + If-Match -> { branchId, expectedVersion }; 200 + ETag', async (op) => {
    const r = await h(op)(req({ params: { branch_id: BR_A1 }, headers: { 'if-match': '"7"' }, body: { tenant_id: TENANT_B } }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { branchId: BR_A1, expectedVersion: 7 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
});

describe('centres: request -> service mapping and responses', () => {
  it.each([
    [{ branch_id: BR_A1, kind: 'own', is_active: 'true' }, { branchId: BR_A1, kind: 'own', isActive: true }], [{ is_active: false }, { isActive: false }], [{}, {}], [{ kind: 'franchise' }, { kind: 'franchise' }],
  ])('listCentres query %j -> %j; 200, no ETag', async (query, input) => {
    const r = await h('listCentres')(req({ query }), hctx('listCentres'));
    expect(svc['listCentres']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), input); expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('createCentre: snake_case body -> camelCase input; 201 + ETag; only known fields forwarded', async () => {
    svc['createCentre']!.mockResolvedValueOnce({ status: 201, body: { centre_id: CE_A1 }, version: 1 });
    const r = await h('createCentre')(req({ body: { code: 'C000000002', name: 'Demo', branch_id: BR_A1, kind: 'own', address_text: 'a', phone: 'p', tenant_id: TENANT_B, centre_id: CE_A1, id: CE_A1, version: 9, is_active: false } }), hctx('createCentre'));
    const input = svc['createCentre']!.mock.calls[0]![1];
    expect(input).toEqual({ code: 'C000000002', name: 'Demo', branchId: BR_A1, kind: 'own', addressText: 'a', phone: 'p' });
    expect(Object.keys(input).sort()).toEqual(['addressText', 'branchId', 'code', 'kind', 'name', 'phone']);
    expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
    expect(svc['createCentre']!.mock.calls[0]![0].tenantId).toBe(TENANT_A);
  });
  it('updateCentre: If-Match + body -> expectedVersion + fields; code / tenant_id / is_active / version dropped; 200 + ETag', async () => {
    const r = await h('updateCentre')(req({ params: { centre_id: CE_A1 }, headers: { 'if-match': '"3"' }, body: { name: 'N', branch_id: BR_A1, kind: 'franchise', address_text: 'a', phone: 'p', unset: ['address_text'], code: 'HIJACK', tenant_id: TENANT_B, is_active: false, version: 9 } }), hctx('updateCentre'));
    expect(svc['updateCentre']).toHaveBeenCalledWith(expect.anything(), { centreId: CE_A1, expectedVersion: 3, name: 'N', branchId: BR_A1, kind: 'franchise', addressText: 'a', phone: 'p', unset: ['address_text'] });
    expect(Object.keys(svc['updateCentre']!.mock.calls[0]![1]).sort()).toEqual(['addressText', 'branchId', 'centreId', 'expectedVersion', 'kind', 'name', 'phone', 'unset']);
    expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(['deactivateCentre', 'reactivateCentre'])('%s: path centre_id + If-Match -> { centreId, expectedVersion }; 200 + ETag', async (op) => {
    const r = await h(op)(req({ params: { centre_id: CE_A1 }, headers: { 'if-match': '"7"' } }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { centreId: CE_A1, expectedVersion: 7 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
});

describe('If-Match parsing (all six conditional operations)', () => {
  it.each(['updateBranch', 'deactivateBranch', 'reactivateBranch', 'updateCentre', 'deactivateCentre', 'reactivateCentre'])('%s: absent -> expectedVersion undefined (service answers 428); malformed -> 0 (service answers 400), never a thrown crash', async (op) => {
    const params = op.endsWith('Branch') ? { branch_id: BR_A1 } : { centre_id: CE_A1 };
    await h(op)(req({ params, body: { name: 'n' } }), hctx(op));
    expect(svc[op]!.mock.calls[0]![1].expectedVersion).toBeUndefined();
    for (const bad of ['2', 'W/"2"', '"0"', '"-1"', '"1.5"', '"abc"', '"99999999999"', '*', '']) {
      svc[op]!.mockClear();
      await h(op)(req({ params, headers: { 'if-match': bad }, body: { name: 'n' } }), hctx(op));
      expect([0, undefined]).toContain(svc[op]!.mock.calls[0]![1].expectedVersion);
    }
  });
});

describe('contract (contracts/openapi/identity.yaml) — operation names, permissions, idempotency, error codes', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'post', 'put', 'delete', 'patch']) if (item[m]?.operationId) ops[item[m].operationId] = { ...item[m], __path: Object.keys(spec.paths).find((p) => spec.paths[p] === item), __method: m };
  const COND = ['common.version_conflict', 'common.precondition_required'];
  it.each([
    ['listBranches', 'get', '/v1/identity/branches', 'identity.user.read', 'none', []],
    ['createBranch', 'post', '/v1/identity/branches', 'identity.centre.manage', 'required', ['identity.code_duplicate']],
    ['updateBranch', 'patch', '/v1/identity/branches/{branch_id}', 'identity.centre.manage', 'optional', COND],
    ['deactivateBranch', 'post', '/v1/identity/branches/{branch_id}/deactivate', 'identity.centre.manage', 'optional', ['identity.centre_inactive', ...COND]],
    ['reactivateBranch', 'post', '/v1/identity/branches/{branch_id}/reactivate', 'identity.centre.manage', 'optional', COND],
    ['listCentres', 'get', '/v1/identity/centres', 'identity.centre.read', 'none', []],
    ['createCentre', 'post', '/v1/identity/centres', 'identity.centre.manage', 'required', ['identity.code_duplicate', 'identity.centre_inactive']],
    ['updateCentre', 'patch', '/v1/identity/centres/{centre_id}', 'identity.centre.manage', 'optional', COND],
    ['deactivateCentre', 'post', '/v1/identity/centres/{centre_id}/deactivate', 'identity.centre.manage', 'optional', COND],
    ['reactivateCentre', 'post', '/v1/identity/centres/{centre_id}/reactivate', 'identity.centre.manage', 'optional', COND],
  ])('%s: %s %s, x-permission %s, x-idempotency %s, x-error-codes include %j', (op, method, path, perm, idem, codes) => {
    expect(ops[op].__method).toBe(method); expect(ops[op].__path).toBe(path);
    expect(ops[op]['x-permission']).toBe(perm); expect(ops[op]['x-idempotency']).toBe(idem);
    for (const c of codes) expect(ops[op]['x-error-codes']).toContain(c);
  });
  it('the request schemas expose no code on update, no tenant_id / is_active / version anywhere on create/update (mass-assignment surface)', () => {
    const s = spec.components.schemas;
    for (const n of ['BranchUpdateRequest', 'CentreUpdateRequest']) expect(Object.keys(s[n].properties)).not.toContain('code');
    for (const n of ['BranchCreateRequest', 'BranchUpdateRequest', 'CentreCreateRequest', 'CentreUpdateRequest']) {
      expect(s[n].additionalProperties).toBe(false);
      for (const k of ['tenant_id', 'is_active', 'version', 'id']) expect(Object.keys(s[n].properties)).not.toContain(k);
    }
  });
});
