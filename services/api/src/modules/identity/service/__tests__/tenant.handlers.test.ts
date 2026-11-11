// T22 HTTP wiring of the 12 platform tenant operations (02-TRD s5.10; contracts/openapi/identity.yaml). The SERVICE is mocked (behaviour: tenant.service.test.ts):
// these tests fix req -> service input mapping, status codes, ETag / If-Match, mass assignment, fail-closed behaviour, and the contract guards the pipeline relies on
// (x-context platform, x-permission, x-idempotency: provisionTenant + inviteTenantAdmin REQUIRED so the core platform idempotency store (tenant_id NULL, D-213) replays them).
// Expected now: the 12 handlers are common.internal stubs and createTenantService does not exist.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { PSESSION, REQ_ID, STAFF_ID, STAFF_USER, TENANT_A, TENANT_B, rejection } from './tenant.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listTenants', 'provisionTenant', 'getTenant', 'updateTenant', 'activateTenant', 'suspendTenant', 'reactivateTenant', 'terminateTenant', 'getTenantSettingsAsPlatform',
  'updateTenantSettingsAsPlatform', 'setFeatureFlagAsPlatform', 'inviteTenantAdmin'];
vi.mock('../tenant.service.js', () => ({ createTenantService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];
const noop = { info() {}, warn() {}, error() {} };
const hctx = (operationId: string, o: Record<string, unknown> = {}) => ({
  operationId, clientIp: '203.0.113.9', log: noop, actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION, aal: 'aal2', requestId: REQ_ID, tx: { __tx: 1 }, ...o,
});
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const EXPECT_STATUS: Record<string, number> = { provisionTenant: 201, inviteTenantAdmin: 201 };
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: EXPECT_STATUS[op] ?? 200, body: { ok: op }, version: 3 })); });
const call = (op: string, r: ReturnType<typeof req>, c = hctx(op)) => h(op)(r, c);
const arg = (op: string) => svc[op]!.mock.calls[0]![1];
const P = { tenant_id: TENANT_A };
const IFM = { 'if-match': '"3"' };

describe('no longer stubs; fail closed without an authenticated platform request context', () => {
  it.each(OPS)('%s: no actor/tx -> auth.unauthenticated; service never called', async (op) => {
    const e = await rejection(h(op)(req({ params: P }), { operationId: op, clientIp: '203.0.113.9', log: noop })); expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('service errors propagate unchanged and echo no request input', async () => {
    const planted = 'PLANTED-TOKEN-7c1d'; svc['terminateTenant']!.mockRejectedValueOnce(new LimsError('common.version_conflict'));
    const e = await rejection(call('terminateTenant', req({ params: { tenant_id: planted }, headers: { authorization: planted, 'if-match': '"1"' }, body: { confirm_code: planted, reason_text: planted } })));
    expect(e.code).toBe('common.version_conflict'); expect(JSON.stringify({ c: e.code, m: e.message, d: e.detail })).not.toContain(planted);
  });
  it('the platform ctx is passed to the service untouched (service authorises itself)', async () => {
    await call('getTenant', req({ params: P })); expect(svc['getTenant']!.mock.calls[0]![0]).toMatchObject({ platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION, aal: 'aal2', actor: { id: STAFF_USER } });
  });
});

describe('listTenants / getTenant', () => {
  it('query (snake) -> filters; unknown keys dropped; 200 without ETag', async () => {
    const r = await call('listTenants', req({ query: { status: 'active', sort: '-created_at', cursor: 'c1', limit: '25', evil: '1' } }));
    expect(arg('listTenants')).toMatchObject({ status: 'active', sort: '-created_at', cursor: 'c1' }); expect(Number(arg('listTenants').limit)).toBe(25); expect(arg('listTenants')).not.toHaveProperty('evil'); expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('getTenant: path id -> {tenantId}; 200 + ETag "<version>"; query/body ignored', async () => {
    const r = await call('getTenant', req({ params: P, query: { tenant_id: TENANT_B }, body: { tenant_id: TENANT_B } })); expect(arg('getTenant')).toEqual({ tenantId: TENANT_A }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
});

describe('provisionTenant', () => {
  const acc = { version: '2026-11', accepted_by_name: 'Demo Owner', accepted_by_title: 'Managing Director', accepted_at: '2026-11-10T09:00:00.000Z' };
  const body = { code: 'synthetic_gamma', legal_name: 'Synthetic Gamma Lab', display_name: 'Synthetic Gamma', pan: '123456789', timezone: 'Asia/Kathmandu', calendar_display: 'AD_BS', training_mode: true,
    first_branch: { code: 'KTM-01', name: 'Main', address_text: 'Road 1' }, first_centre: { code: 'C000000010', name: 'Centre', kind: 'own', address_text: 'Road 2' }, first_admin: { email: 'a@gamma.example.test', display_name: 'Gamma Admin' },
    contract_acceptance: { tos: acc, dpa: { ...acc, version: '2026-10' } } };
  it('POST body (snake) -> service input (camel, nested); 201 + ETag', async () => {
    const r = await call('provisionTenant', req({ body })); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"3"');
    expect(arg('provisionTenant')).toEqual({ code: 'synthetic_gamma', legalName: 'Synthetic Gamma Lab', displayName: 'Synthetic Gamma', pan: '123456789', timezone: 'Asia/Kathmandu', calendarDisplay: 'AD_BS', trainingMode: true,
      firstBranch: { code: 'KTM-01', name: 'Main', addressText: 'Road 1' }, firstCentre: { code: 'C000000010', name: 'Centre', kind: 'own', addressText: 'Road 2' }, firstAdmin: { email: 'a@gamma.example.test', displayName: 'Gamma Admin' },
      contractAcceptance: { tos: { version: '2026-11', acceptedByName: 'Demo Owner', acceptedByTitle: 'Managing Director', acceptedAt: '2026-11-10T09:00:00.000Z' }, dpa: { version: '2026-10', acceptedByName: 'Demo Owner', acceptedByTitle: 'Managing Director', acceptedAt: '2026-11-10T09:00:00.000Z' } } });
  });
  it('mass assignment: status, tenant_id, id, version, created_by, activated_at (top level and nested) never reach the service', async () => {
    await call('provisionTenant', req({ body: { ...body, status: 'active', tenant_id: TENANT_B, id: TENANT_B, version: 9, created_by: 'x', activated_at: 'x', first_admin: { ...body.first_admin, role: 'platform_superadmin', status: 'active' }, contract_acceptance: { ...body.contract_acceptance, extra: 1 } }, query: { tenant_id: TENANT_B } }));
    const a = arg('provisionTenant'); for (const k of Object.keys(a)) expect(['code', 'legalName', 'displayName', 'pan', 'timezone', 'calendarDisplay', 'trainingMode', 'firstBranch', 'firstCentre', 'firstAdmin', 'contractAcceptance']).toContain(k);
    expect(Object.keys(a.firstAdmin).sort()).toEqual(['displayName', 'email']); expect(Object.keys(a.contractAcceptance).sort()).toEqual(['dpa', 'tos']);
  });
  it('a missing / non-object body reaches the service as undefined fields (service answers 400), never a crash', async () => {
    for (const b of [undefined, null, 'x', 5, []]) { svc['provisionTenant']!.mockClear(); await call('provisionTenant', req({ body: b })); expect(svc['provisionTenant']!.mock.calls[0]![1].code).toBeUndefined(); }
  });
});

describe('lifecycle + settings + flags + invite: path / If-Match / body -> service input', () => {
  it('updateTenant: If-Match + body; code/status in body are NOT forwarded as input except via the service validation path (only the four documented fields + unset)', async () => {
    await call('updateTenant', req({ params: P, headers: IFM, body: { legal_name: 'N', display_name: 'D', billing_live_on: '2026-12-01', unset: ['billing_live_on'], status: 'offboarded', actor_id: 'x' } }));
    expect(arg('updateTenant')).toEqual({ tenantId: TENANT_A, expectedVersion: 3, legalName: 'N', displayName: 'D', billingLiveOn: '2026-12-01', unset: ['billing_live_on'] });
  });
  it('updateTenant: a body `code` reaches the service so that it can answer 400 /code (immutable)', async () => { await call('updateTenant', req({ params: P, headers: IFM, body: { code: 'x' } })); expect(arg('updateTenant').code).toBe('x'); });
  it.each([['activateTenant', {}, {}], ['reactivateTenant', {}, {}], ['suspendTenant', { reason_text: 'Synthetic reason' }, { reasonText: 'Synthetic reason' }],
    ['terminateTenant', { confirm_code: 'synthetic_alpha', reason_text: 'Synthetic reason' }, { confirmCode: 'synthetic_alpha', reasonText: 'Synthetic reason' }]])('%s: path id + If-Match + body -> service; 200 + new ETag', async (op, b, extra) => {
    const r = await call(op, req({ params: P, headers: IFM, body: { ...b, tenant_id: TENANT_B, status: 'active' } })); expect(arg(op)).toEqual({ tenantId: TENANT_A, expectedVersion: 3, ...extra }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(['updateTenant', 'activateTenant', 'suspendTenant', 'reactivateTenant', 'terminateTenant', 'updateTenantSettingsAsPlatform'])('%s: If-Match absent -> expectedVersion undefined (428 from the service); malformed -> 0 or undefined, never a crash', async (op) => {
    await call(op, req({ params: P, body: {} })); expect(arg(op).expectedVersion).toBeUndefined();
    for (const bad of ['3', 'W/"3"', '"0"', '"-1"', '"1.5"', '"abc"', '"99999999999"', '*', '']) { svc[op]!.mockClear(); await call(op, req({ params: P, headers: { 'if-match': bad }, body: {} })); expect([0, undefined]).toContain(svc[op]!.mock.calls[0]![1].expectedVersion); }
  });
  it('getTenantSettingsAsPlatform: {tenantId}; updateTenantSettingsAsPlatform: body passed as `patch` verbatim (service whitelists), tenant from the path only', async () => {
    await call('getTenantSettingsAsPlatform', req({ params: P })); expect(arg('getTenantSettingsAsPlatform')).toEqual({ tenantId: TENANT_A });
    await call('updateTenantSettingsAsPlatform', req({ params: P, headers: IFM, body: { idle_timeout_minutes: 45, training_mode: true, tenant_id: TENANT_B } }), hctx('updateTenantSettingsAsPlatform'));
    const a = arg('updateTenantSettingsAsPlatform'); expect(a).toMatchObject({ tenantId: TENANT_A, expectedVersion: 3 }); expect(a.patch).toEqual({ idle_timeout_minutes: 45, training_mode: true, tenant_id: TENANT_B });
  });
  it('setFeatureFlagAsPlatform: PUT path ids + body -> {tenantId, flagCode, isEnabled, approvalRef}; unknown body keys dropped', async () => {
    await call('setFeatureFlagAsPlatform', req({ params: { ...P, flag_code: 'synthetic_founder_flag' }, body: { is_enabled: true, approval_ref: 'FOUNDER-0042', tenant_id: TENANT_B, version: 4 } }));
    expect(arg('setFeatureFlagAsPlatform')).toEqual({ tenantId: TENANT_A, flagCode: 'synthetic_founder_flag', isEnabled: true, approvalRef: 'FOUNDER-0042' });
  });
  it('inviteTenantAdmin: body -> {tenantId, email, displayName}; 201; role / status in body are not forwarded', async () => {
    const r = await call('inviteTenantAdmin', req({ params: P, body: { email: 'a@alpha.example.test', display_name: 'Admin', role: 'platform_superadmin', status: 'active' } }));
    expect(arg('inviteTenantAdmin')).toEqual({ tenantId: TENANT_A, email: 'a@alpha.example.test', displayName: 'Admin' }); expect(r.status).toBe(201);
  });
  it('path id missing / not a string reaches the service as undefined (it answers 404), never a crash', async () => { for (const op of ['getTenant', 'activateTenant', 'inviteTenantAdmin']) { await call(op, req({ params: {}, headers: IFM, body: {} })); expect(arg(op).tenantId).toBeUndefined(); svc[op]!.mockClear(); } });
});

describe('contract + registration (the guards the pipeline applies before the handler)', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops = new Map<string, any>();
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const [m, op] of Object.entries<any>(item)) if (op?.operationId) ops.set(op.operationId, { path, m, ...op });
  const R = 'platform.tenant.read', M = 'platform.tenant.manage';
  it.each([['listTenants', R, 'none', 'get', '/platform/tenants'], ['provisionTenant', M, 'required', 'post', '/platform/tenants'], ['getTenant', R, 'none', 'get', '/platform/tenants/{tenant_id}'],
    ['updateTenant', M, 'optional', 'patch', '/platform/tenants/{tenant_id}'], ['activateTenant', M, 'optional', 'post', '/platform/tenants/{tenant_id}/activate'], ['suspendTenant', M, 'optional', 'post', '/platform/tenants/{tenant_id}/suspend'],
    ['reactivateTenant', M, 'optional', 'post', '/platform/tenants/{tenant_id}/reactivate'], ['terminateTenant', M, 'optional', 'post', '/platform/tenants/{tenant_id}/terminate'],
    ['getTenantSettingsAsPlatform', R, 'none', 'get', '/platform/tenants/{tenant_id}/settings'], ['updateTenantSettingsAsPlatform', M, 'optional', 'patch', '/platform/tenants/{tenant_id}/settings'],
    ['setFeatureFlagAsPlatform', M, 'optional', 'put', '/platform/tenants/{tenant_id}/feature-flags/{flag_code}'], ['inviteTenantAdmin', M, 'required', 'post', '/platform/tenants/{tenant_id}/admin-invitations']])(
    '%s: x-context platform, x-permission %s, x-idempotency %s, %s %s', (op, perm, idem, method, path) => { expect(ops.get(op)).toMatchObject({ 'x-context': 'platform', 'x-permission': perm, 'x-idempotency': idem, m: method, path: `/v1/identity${path}` }); });
  it('provisionTenant lists identity.code_duplicate + identity.setting_out_of_range; activateTenant lists identity.tenant_not_ready', () => {
    expect(ops.get('provisionTenant')['x-error-codes']).toEqual(expect.arrayContaining(['identity.code_duplicate', 'identity.setting_out_of_range'])); expect(ops.get('activateTenant')['x-error-codes']).toEqual(expect.arrayContaining(['identity.tenant_not_ready']));
  });
  it.each(OPS)('%s is registered in the identity manifest and is not the common.internal stub', async (op) => { expect(typeof h(op)).toBe('function'); const e = await h(op)(req({ params: P, headers: IFM, body: {} }), hctx(op)).catch((x: any) => x); expect(e?.code).not.toBe('common.internal'); });
});
