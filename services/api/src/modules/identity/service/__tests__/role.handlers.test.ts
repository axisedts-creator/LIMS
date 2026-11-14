// T14 HTTP wiring of listPermissions, listRoles, createRole, getRole, updateRole, deactivateRole (02-TRD §5.4; contracts/openapi/identity.yaml).
// The role SERVICE is mocked (behaviour is in role.service.test.ts): these tests fix req -> service input mapping, status codes, ETag, If-Match parsing,
// mass-assignment stripping and fail-closed behaviour. Schema validation, x-permission and Idempotency-Key are the core pipeline's.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { R_FD, TENANT_A, TENANT_B, makeCtx, rejection } from './role.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listPermissions', 'listRoles', 'createRole', 'getRole', 'updateRole', 'deactivateRole'];
vi.mock('../role.service.js', () => ({ createRoleService: () => svc }));
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
    const planted = 'PLANTED-TOKEN-9f3a'; svc['getRole']!.mockRejectedValueOnce(new LimsError('common.not_found'));
    const e = await rejection(h('getRole')(req({ params: { role_id: planted }, headers: { authorization: planted } }), hctx('getRole')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
  it('service errors propagate unchanged (the core renders them)', async () => {
    svc['createRole']!.mockRejectedValueOnce(new LimsError('identity.code_duplicate'));
    expect((await rejection(h('createRole')(req({ body: {} }), hctx('createRole')))).code).toBe('identity.code_duplicate');
  });
});

describe('request -> service mapping and responses', () => {
  it('listPermissions: 200 body passthrough, no ETag', async () => {
    const r = await h('listPermissions')(req(), hctx('listPermissions'));
    expect(svc['listPermissions']).toHaveBeenCalledTimes(1); expect(r.status).toBe(200); expect(r.body).toEqual({ ok: 'listPermissions' }); expect(r.headers?.etag).toBeUndefined();
  });
  it.each([[{ is_active: true }, { isActive: true }], [{ is_active: false }, { isActive: false }], [{}, {}]])('listRoles query %j -> %j', async (query, input) => {
    const r = await h('listRoles')(req({ query }), hctx('listRoles'));
    expect(svc['listRoles']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), input); expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('createRole: snake_case body -> camelCase input; 201 + ETag of the new version; only known fields forwarded (mass assignment)', async () => {
    svc['createRole']!.mockResolvedValueOnce({ status: 201, body: { role_id: R_FD }, version: 1 });
    const r = await h('createRole')(req({ body: { code: 'front_desk', name: 'Front desk', description: 'd', permission_codes: ['identity.self.manage'], mfa_required: false, tenant_id: TENANT_B, is_default: true, role_id: R_FD, version: 9, permissions: ['platform.tenant.manage'] } }), hctx('createRole'));
    const input = svc['createRole']!.mock.calls[0]![1];
    expect(input).toEqual({ code: 'front_desk', name: 'Front desk', description: 'd', permissionCodes: ['identity.self.manage'], mfaRequired: false });
    expect(Object.keys(input).sort()).toEqual(['code', 'description', 'mfaRequired', 'name', 'permissionCodes']);
    expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('the tenant given to the service is the context tenant, never one from params/query/body', async () => {
    await h('createRole')(req({ body: { tenant_id: TENANT_B, code: 'x1', name: 'n', permission_codes: ['identity.self.manage'], mfa_required: false }, query: { tenant_id: TENANT_B } }), hctx('createRole'));
    expect(svc['createRole']!.mock.calls[0]![0].tenantId).toBe(TENANT_A);
  });
  it('getRole: path role_id -> roleId; 200 + ETag "<version>"', async () => {
    const r = await h('getRole')(req({ params: { role_id: R_FD } }), hctx('getRole'));
    expect(svc['getRole']).toHaveBeenCalledWith(expect.anything(), { roleId: R_FD }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('updateRole: If-Match + body -> expectedVersion + fields; 200 + ETag; unknown body keys dropped', async () => {
    const r = await h('updateRole')(req({ params: { role_id: R_FD }, headers: { 'if-match': '"2"' }, body: { name: 'N', description: 'd', permission_codes: ['identity.self.manage'], mfa_required: true, code: 'hijack', tenant_id: TENANT_B, is_default: true } }), hctx('updateRole'));
    expect(svc['updateRole']).toHaveBeenCalledWith(expect.anything(), { roleId: R_FD, expectedVersion: 2, name: 'N', description: 'd', permissionCodes: ['identity.self.manage'], mfaRequired: true });
    expect(Object.keys(svc['updateRole']!.mock.calls[0]![1]).sort()).toEqual(['description', 'expectedVersion', 'mfaRequired', 'name', 'permissionCodes', 'roleId']);
    expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('deactivateRole: If-Match -> expectedVersion; 200 + ETag', async () => {
    const r = await h('deactivateRole')(req({ params: { role_id: R_FD }, headers: { 'if-match': '"7"' } }), hctx('deactivateRole'));
    expect(svc['deactivateRole']).toHaveBeenCalledWith(expect.anything(), { roleId: R_FD, expectedVersion: 7 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(['updateRole', 'deactivateRole'])('%s If-Match: absent -> expectedVersion undefined (service answers 428); malformed -> 0 (service answers 400), never a thrown crash', async (op) => {
    await h(op)(req({ params: { role_id: R_FD }, body: { name: 'n', permission_codes: ['identity.self.manage'], mfa_required: false } }), hctx(op));
    expect(svc[op]!.mock.calls[0]![1].expectedVersion).toBeUndefined();
    for (const bad of ['2', 'W/"2"', '"0"', '"-1"', '"1.5"', '"abc"', '"99999999999"', '*', '']) {
      svc[op]!.mockClear();
      await h(op)(req({ params: { role_id: R_FD }, headers: { 'if-match': bad }, body: { name: 'n', permission_codes: ['identity.self.manage'], mfa_required: false } }), hctx(op));
      expect([0, undefined]).toContain(svc[op]!.mock.calls[0]![1].expectedVersion);
    }
  });
});

describe('contract (contracts/openapi/identity.yaml) — operation names, permissions, idempotency, error codes', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'post', 'put', 'delete', 'patch']) if (item[m]?.operationId) ops[item[m].operationId] = item[m];
  it.each([
    ['listPermissions', 'identity.user.read', 'none', []], ['listRoles', 'identity.user.read', 'none', []], ['getRole', 'identity.user.read', 'none', []],
    ['createRole', 'identity.role.manage', 'required', ['identity.code_duplicate']],
    ['updateRole', 'identity.role.manage', 'optional', ['identity.last_admin_protected', 'common.version_conflict', 'common.precondition_required']],
    ['deactivateRole', 'identity.role.manage', 'optional', ['identity.last_admin_protected', 'common.version_conflict', 'common.precondition_required']],
  ])('%s: x-permission %s, x-idempotency %s, x-error-codes include %j', (op, perm, idem, codes) => {
    expect(ops[op]['x-permission']).toBe(perm); expect(ops[op]['x-idempotency']).toBe(idem);
    for (const c of codes) expect(ops[op]['x-error-codes']).toContain(c);
  });
});
