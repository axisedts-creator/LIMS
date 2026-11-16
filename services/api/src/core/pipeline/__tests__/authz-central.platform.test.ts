// SEC-AUTHZ-3 (LD-189 AUTH-SENSITIVE, LD-261, LD-277; CR .orchestra/cr/SEC-AUTHZ-1.1.nonblocking.md item 7; C0 02-TRD 6.2 stage 8a + 9;
// C2 02-TRD 7.2 step 3 + 4; C0 07-SECURITY AB-5): all platform.* operations are checked CENTRALLY by PlatformAuthz.assertPlatform with their
// x-permission, before the handler. Names come from contracts/openapi (line scan), never typed here. No new interface is pinned:
// SEC-AUTHZ-2's PipelineOp.permission/.scheme, authzMode and the authz_central_deny log + metric are reused.
// Behaviour pinned (the spec fixes it): IdentityPort.assertRole is NEVER asked for a platform.* permission (the real port rejects it, IdentityPort.impl.ts:229);
// a deny is auth.forbidden / auth.mfa_required exactly as PlatformAuthz throws; shadow logs + counts and continues; a checked operation counts as asserted for stage 9.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICE, denies, notAsserted, rejects, rig, staffOp, SUB, TENANT_A, user } from './authz-central-rig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');
const CONTRACTS = path.join(ROOT, 'contracts', 'openapi');

interface C { module: string; operationId: string; permission: string | null; method: string; scheme: string | null }
function scan(): C[] {
  const out: C[] = [];
  for (const f of readdirSync(CONTRACTS).filter((n) => n.endsWith('.yaml') && !n.startsWith('_')).sort()) {
    let cur: C | undefined; let method = ''; let inSecurity = false;
    for (const line of readFileSync(path.join(CONTRACTS, f), 'utf8').split(/\r?\n/)) {
      const mm = line.match(/^ {4}(get|put|post|patch|delete):\s*$/);
      if (mm) { method = mm[1]!.toUpperCase(); continue; }
      let m = line.match(/^ {6}operationId:\s*(\S+)\s*$/);
      if (m) { cur = { module: f.replace(/\.yaml$/, ''), operationId: m[1]!, permission: null, method, scheme: null }; out.push(cur); inSecurity = false; continue; }
      if (!cur) continue;
      if (/^ {6}security:/.test(line)) { inSecurity = true; continue; }
      if (inSecurity && /^ {8}-/.test(line)) { cur.scheme ??= (line.match(/\{\s*(\w+)\s*:/)?.[1] ?? null); continue; }
      if (inSecurity && !/^ {8}/.test(line)) inSecurity = false;
      m = line.match(/^ {6}x-permission:\s*(\S+)\s*$/);
      if (m) cur.permission = m[1]!;
    }
  }
  return out;
}
const ALL = scan();
const PLATFORM = ALL.filter((c) => c.permission?.startsWith('platform.'));
const opOf = (c: C) => staffOp({ module: c.module, operationId: c.operationId, method: c.method, permission: c.permission, scheme: c.scheme ?? 'bearerJwt', context: 'platform' });

// the platform session as the claims resolver builds it (pipeline/index.ts buildCtx): user actor, scope platform, no tenant, platform_ role, aal.
const plat = (role = 'platform_superadmin', aal = 'aal2', extra: Record<string, unknown> = {}) =>
  ({ sub: SUB, actor_type: 'user', scope: 'platform', platform_role: role, aal, ...extra }) as any;
// registry facts (contracts/ports/generated/permissions.ts ROLE_GRANTS; all five platform.* codes are PRIVILEGED = aal2)
const SUPPORT_CODES = ['platform.support_session.open', 'platform.tenant.read'];
const ALL_CODES = ['platform.dead_letter.manage', 'platform.staff.manage', 'platform.support_session.open', 'platform.tenant.manage', 'platform.tenant.read'];

describe('contract scan sanity (the 34 platform.* operations)', () => {
  it('34 operations, only the five registry codes, all bearerJwt', () => {
    expect(PLATFORM).toHaveLength(34);
    for (const c of PLATFORM) { expect(ALL_CODES, c.operationId).toContain(c.permission); expect(c.scheme, c.operationId).toBe('bearerJwt'); }
    expect(new Set(PLATFORM.map((c) => c.operationId)).size).toBe(34);
  });
});

describe.each(PLATFORM.map((c) => [c.operationId, c] as const))('platform.* %s', (_id, c) => {
  const perm = c.permission!;
  const allowedForSupport = SUPPORT_CODES.includes(perm);

  it('platform_superadmin at aal2: reaches the handler; IdentityPort.assertRole is never asked; stage 9 sees an assertion on staging', async () => {
    const r = rig({ env: 'staging', mode: 'enforce', profile: { permissions: [] } });
    const res = await r.run({ op: opOf(c), claims: plat() });
    expect(res.status).toBe(200);
    expect(r.handlerCalls).toEqual(['handler']);
    expect(r.asserted).toEqual([]);
    expect(denies(r)).toEqual([]);
    expect(notAsserted(r)).toEqual([]); // the handler asserted nothing itself: the central PlatformAuthz call is the assertion
  });

  it('tenant actor (even one holding the platform code in its tenant profile): auth.forbidden, handler and repository never called, deny logged with the x-permission', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [perm] } });
    const e = await rejects(r.run({ op: opOf(c), claims: user }));
    expect(e.code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
    expect(r.repoCalls).toEqual([]);
    expect(r.asserted).toEqual([]); // not via assertRole: it rejects platform.* and a fake that accepts it must not be reachable
    expect(denies(r)).toHaveLength(1);
    expect(denies(r)[0]!.obj).toMatchObject({ event: 'authz_central_deny', operation_id: c.operationId, actor_type: 'user', permission: perm, mode: 'enforce' });
  });

  it('platform_support: allowed only for the codes the registry grants it (support_session.open, tenant.read); otherwise auth.forbidden before the handler', async () => {
    const r = rig({ mode: 'enforce' });
    if (allowedForSupport) {
      expect((await r.run({ op: opOf(c), claims: plat('platform_support') })).status).toBe(200);
      expect(r.handlerCalls).toEqual(['handler']);
    } else {
      expect((await rejects(r.run({ op: opOf(c), claims: plat('platform_support') }))).code).toBe('auth.forbidden');
      expect(r.handlerCalls).toEqual([]);
      expect(r.repoCalls).toEqual([]);
    }
  });

  it('platform_superadmin at aal1 (no MFA step-up): auth.mfa_required before the handler (privileged code, REQ-SEC-067)', async () => {
    const r = rig({ mode: 'enforce' });
    expect((await rejects(r.run({ op: opOf(c), claims: plat('platform_superadmin', 'aal1') }))).code).toBe('auth.mfa_required');
    expect(r.handlerCalls).toEqual([]);
    expect(r.repoCalls).toEqual([]);
  });

  it('shadow: a tenant actor is logged and counted (operation_id label only) but the handler runs; stage 9 does not 500 on staging', async () => {
    const r = rig({ env: 'staging', mode: 'shadow' });
    const res = await r.run({ op: opOf(c), claims: user, handler: async () => ({ status: 200, body: {} }) });
    expect(res.status).toBe(200);
    expect(denies(r)).toHaveLength(1);
    expect(denies(r)[0]!.obj).toMatchObject({ operation_id: c.operationId, permission: perm, mode: 'shadow' });
    expect(r.incs.filter(([n]) => n === 'lims_core_authz_central_deny_total')).toEqual([['lims_core_authz_central_deny_total', { operation_id: c.operationId }]]);
    expect(notAsserted(r)).toEqual([]);
  });
});

describe('platform.* actors and claims that must never pass (one operation; the check is the same for all 34)', () => {
  const c = PLATFORM.find((x) => x.operationId === 'listTenants')!; // platform.tenant.read, held by both platform roles
  const denyCase = async (claims: any, o: Parameters<typeof rig>[0] = {}) => {
    const r = rig({ mode: 'enforce', ...o });
    const e = await rejects(r.run({ op: opOf(c), claims }));
    expect(e.code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
    expect(r.repoCalls).toEqual([]);
    expect(r.asserted).toEqual([]);
    return r;
  };

  it.each(['patient', 'partner', 'portal'])('%s actor, even with stray platform claims: auth.forbidden', async (actor) => {
    await denyCase({ sub: SUB, actor_type: actor, scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2' });
    await denyCase({ sub: SUB, tenant_id: TENANT_A, actor_type: actor, aal: 'aal2' });
  });
  it('system actor holding the code in the module systemPermissions: auth.forbidden (system actors hold no platform.* permission)', async () => {
    await denyCase({ sub: SUB, actor_type: 'system', scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2' }, { system: { identity: ['platform.tenant.read'] } });
  });
  it('device actor even when its credential permissions list the code: auth.forbidden, IdentityPort not asked', async () => {
    await denyCase({ sub: DEVICE, tenant_id: TENANT_A, actor_type: 'device' }, { devices: { [DEVICE]: ['platform.tenant.read'] } });
  });
  it('unknown or missing actor_type: auth.forbidden', async () => {
    await denyCase({ sub: SUB, scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2' });
    await denyCase({ sub: SUB, actor_type: 'robot', scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2' });
  });
  it('tenant claims carrying a stray platform_role (scope tenant, tenant_id present): auth.forbidden', async () => {
    await denyCase({ sub: SUB, tenant_id: TENANT_A, actor_type: 'user', scope: 'tenant', platform_role: 'platform_superadmin', aal: 'aal2' });
    await denyCase({ sub: SUB, tenant_id: TENANT_A, actor_type: 'user', scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2' });
  });
  it('platform session with no, an unknown, or a non-platform role: auth.forbidden', async () => {
    await denyCase({ sub: SUB, actor_type: 'user', scope: 'platform', aal: 'aal2' });
    await denyCase(plat('platform_ghost'));
    await denyCase(plat('lab_admin'));
  });
  it('request input never grants: platform_role / aal in headers, query or body are ignored', async () => {
    const r = rig({ mode: 'enforce' });
    const e = await rejects(r.run({
      op: opOf(c), claims: user,
      req: { params: {}, query: { platform_role: 'platform_superadmin', aal: 'aal2' }, headers: { 'x-platform-role': 'platform_superadmin' }, body: { platformRole: 'platform_superadmin', aal: 'aal2' } },
    }));
    expect(e.code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
  });
});

describe('modes', () => {
  const c = PLATFORM.find((x) => x.operationId === 'suspendTenant')!; // platform.tenant.manage
  it('default (no LIMS_CORE_AUTHZ_MODE wired) is shadow: tenant actor logged and continues (SEC-AUTHZ-2, LD-261)', async () => {
    const r = rig({ mode: 'unset', env: 'production' });
    const res = await r.run({ op: opOf(c), claims: user, handler: async () => ({ status: 200, body: {} }) });
    expect(res.status).toBe(200);
    expect(denies(r)[0]!.obj).toMatchObject({ mode: 'shadow', permission: 'platform.tenant.manage' });
  });
  it('shadow with a platform_support actor on a manage code: handler runs, deny logged with mode shadow', async () => {
    const r = rig({ mode: 'shadow' });
    expect((await r.run({ op: opOf(c), claims: plat('platform_support') })).status).toBe(200);
    expect(denies(r)).toHaveLength(1);
  });
  it('shadow: an allowed platform actor is not logged as a deny', async () => {
    const r = rig({ mode: 'shadow' });
    await r.run({ op: opOf(c), claims: plat() });
    expect(denies(r)).toEqual([]);
    expect(r.incs.filter(([n]) => n === 'lims_core_authz_central_deny_total')).toEqual([]);
  });
  it('enforce on production: a deny is auth.forbidden and no authz_not_asserted line is produced for the denied request', async () => {
    const r = rig({ env: 'production', mode: 'enforce' });
    expect((await rejects(r.run({ op: opOf(c), claims: user }))).code).toBe('auth.forbidden');
    expect(notAsserted(r)).toEqual([]);
  });
});

describe('no person id, token, email or tenant id in any log line or metric label (LD-189)', () => {
  it('deny log and metric of a platform deny carry only the five documented keys / the operation_id label', async () => {
    const c = PLATFORM.find((x) => x.operationId === 'provisionTenant')!;
    const r = rig({ mode: 'enforce' });
    await rejects(r.run({ op: opOf(c), claims: user, req: { params: {}, query: {}, headers: { authorization: 'Bearer SECRET-TOKEN' }, body: { email: 'someone@example.test' } } }));
    const d = denies(r)[0]!.obj as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(['actor_type', 'event', 'mode', 'operation_id', 'permission']);
    const blob = JSON.stringify([r.rec.calls, r.incs]);
    for (const secret of [SUB, TENANT_A, 'SECRET-TOKEN', 'someone@example.test']) expect(blob.includes(secret), secret).toBe(false);
    expect(r.incs.filter(([n]) => n === 'lims_core_authz_central_deny_total').every(([, l]) => Object.keys(l ?? {}).join() === 'operation_id')).toBe(true);
  });
});

describe('tenant operations and the platform actor (support session rule stays assertRole step 4)', () => {
  const op = () => staffOp(); // frontdesk createThing, x-permission frontdesk.order.create, bearerJwt (rig default tenant operation)
  it('platform actor WITHOUT a support session on a tenant operation: identity.support_session_required before the handler', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [], state: 'support_missing' } });
    const e = await rejects(r.run({ op: op(), claims: plat() }));
    expect(e.code).toBe('identity.support_session_required');
    expect(r.handlerCalls).toEqual([]);
    expect(r.repoCalls).toEqual([]);
    expect(r.asserted).toEqual([{ permission: 'frontdesk.order.create' }]);
  });
  it('platform actor WITH a support session that grants the permission: reaches the handler (no new denial)', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: ['frontdesk.order.create'] } });
    const res = await r.run({ op: op(), claims: plat('platform_support', 'aal2', { tenant_id: TENANT_A, support_session_id: '0190a000-0000-7000-8000-0000000000aa' }) });
    expect(res.status).toBe(200);
    expect(r.asserted).toEqual([{ permission: 'frontdesk.order.create' }]);
  });
  it('shadow: the same platform actor without a session is logged as a deny and continues', async () => {
    const r = rig({ mode: 'shadow', profile: { permissions: [], state: 'support_missing' } });
    expect((await r.run({ op: op(), claims: plat() })).status).toBe(200);
    expect(denies(r)[0]!.obj).toMatchObject({ permission: 'frontdesk.order.create', mode: 'shadow' });
  });
});

describe('untouched flows', () => {
  it('identity session operations (bffSession) stay skipped: no assertRole, no PlatformAuthz, no deny, even in enforce', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] } });
    const res = await r.run({
      op: staffOp({ module: 'identity', operationId: 'loginStaff', permission: undefined, scheme: 'bffSession', public: true }),
      claims: undefined, handler: async () => ({ status: 200, body: {} }),
    });
    expect(res.status).toBe(200);
    expect(r.asserted).toEqual([]);
    expect(denies(r)).toEqual([]);
  });
  it('a tenant bearerJwt operation with a staff permission is unchanged: user without it still auth.forbidden, with it reaches the handler', async () => {
    const o = staffOp();
    const a = rig({ mode: 'enforce', profile: { permissions: [] } });
    expect((await rejects(a.run({ op: o }))).code).toBe('auth.forbidden');
    const b = rig({ mode: 'enforce', profile: { permissions: ['frontdesk.order.create'] } });
    expect((await b.run({ op: o })).status).toBe(200);
  });
});
