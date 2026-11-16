// T0D-PLATFORM-CTX-1 (LD-241, CR-C2-004; C2 02-TRD 5.10 + 7.2 step 3). The 403 the founder saw on staging, reproduced in a unit run:
// platform claims -> REAL pipeline buildCtx (core/pipeline, fake pg only) -> REAL identity handler (manifest.handlers, no vi.mock of any service)
// -> REAL PlatformAuthz. Nothing is faked between the claims and PlatformAuthz.
// "Authorised" = the request got PAST PlatformAuthz: whatever happens afterwards (a later guard answering auth.unauthenticated because
// platformStaffId / db.withTenantScope are not on the context, validation errors, a stage 9 miss) is out of this task (see the tester note).
// "Refused" = PlatformAuthz answered: auth.forbidden (role/permission) or auth.mfa_required (privileged code below aal2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { makeRig, REQ_ID, SUB, TENANT_A } from '../../../../core/pipeline/__tests__/helpers.js';
import { manifest } from '../../index.js';

interface PlatformOp { operationId: string; method: string; path: string; permission: string }
const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8')) as { paths: Record<string, Record<string, any>> };
const PLATFORM_OPS: PlatformOp[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([, o]) => typeof o?.['x-permission'] === 'string' && o['x-permission'].startsWith('platform.'))
    .map(([method, o]) => ({ operationId: o.operationId as string, method: method.toUpperCase(), path, permission: o['x-permission'] as string })));
const CODES = [...new Set(PLATFORM_OPS.map((o) => o.permission))].sort();
const MANAGE = new Set(['platform.tenant.manage', 'platform.staff.manage', 'platform.dead_letter.manage']);  // platform_support does not hold these (permissions.yaml)

const STAFF = '0190a000-0000-7000-8000-00000000c001';
const platformClaims = (role: string, aal: string | undefined) =>
  ({ sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: STAFF, platform_role: role, ...(aal ? { aal } : {}), lims_session_id: REQ_ID }) as any;

/** Runs one operation through the real pipeline; resolves the thrown LimsError code, or 'handled:<status>' when the handler answered. */
async function outcome(o: PlatformOp, claims: Record<string, unknown>): Promise<string> {
  const handler = (manifest.handlers as Record<string, any>)[o.operationId];
  if (typeof handler !== 'function') throw new Error(`no handler for ${o.operationId}`);
  const rig = makeRig({ handler });
  try {
    const r = await rig.run({
      claims,
      op: { module: 'identity', operationId: o.operationId, method: o.method, routeTemplate: `/v1/identity${o.path}`, public: false, context: 'platform', idempotency: 'none', rateLimitTier: 'general' },
      req: { params: {}, query: {}, headers: {}, body: {} },
    });
    return `handled:${r.status}`;
  } catch (e: any) {
    return typeof e?.code === 'string' ? e.code : `crash:${String(e?.message).slice(0, 80)}`;
  }
}
const REFUSED = ['auth.forbidden', 'auth.mfa_required'];
const pastAuthz = (code: string) => !REFUSED.includes(code);

describe('fixture: the 34 platform.* operations of contracts/openapi/identity.yaml', () => {
  it('34 operations declare a platform.* permission, covering the 5 platform.* codes, and each has a handler', () => {
    expect(PLATFORM_OPS).toHaveLength(34);
    expect(CODES).toEqual(['platform.dead_letter.manage', 'platform.staff.manage', 'platform.support_session.open', 'platform.tenant.manage', 'platform.tenant.read']);
    for (const o of PLATFORM_OPS) expect(typeof (manifest.handlers as any)[o.operationId], o.operationId).toBe('function');
  });
});

describe('the reproduced 403: a platform session through the real pipeline and the real PlatformAuthz', () => {
  const NAMED: Array<[string, string]> = [
    ['listTenants', 'platform.tenant.read'], ['listPlatformStaff', 'platform.staff.manage'], ['listPlatformAuthEvents', 'platform.tenant.read'],
    ['provisionTenant', 'platform.tenant.manage'],   // the brief's "createTenant" is provisionTenant in the contract
    ['openSupportSession', 'platform.support_session.open'],
  ];
  const op = (id: string) => PLATFORM_OPS.find((o) => o.operationId === id)!;

  it.each(NAMED)('%s (%s): platform_superadmin + aal2 gets past PlatformAuthz (today: auth.forbidden because ctx.platformRole is never set)', async (id, perm) => {
    expect(op(id).permission).toBe(perm);
    const code = await outcome(op(id), platformClaims('platform_superadmin', 'aal2'));
    expect(code).not.toBe('auth.forbidden');
    expect(code).not.toBe('auth.mfa_required');
  });

  it.each(NAMED)('%s: platform_superadmin with aal1 is refused auth.mfa_required (privileged code, REQ-SEC-067)', async (id) => {
    expect(await outcome(op(id), platformClaims('platform_superadmin', 'aal1'))).toBe('auth.mfa_required');
  });

  it.each(NAMED)('%s: a platform session without an aal claim is refused auth.mfa_required (aal is never invented)', async (id) => {
    expect(await outcome(op(id), platformClaims('platform_superadmin', undefined))).toBe('auth.mfa_required');
  });
});

describe('all 34 platform.* operations x platform roles (existing PlatformAuthz semantics unchanged)', () => {
  const table = PLATFORM_OPS.map((o) => [o.operationId, o.permission, o] as const);

  it.each(table)('%s (%s): platform_superadmin + aal2 passes PlatformAuthz', async (_id, _perm, o) => {
    expect(pastAuthz(await outcome(o, platformClaims('platform_superadmin', 'aal2')))).toBe(true);
  });

  it.each(table)('%s (%s): platform_support + aal2 passes read/open codes and is refused the manage codes (auth.forbidden)', async (_id, perm, o) => {
    const code = await outcome(o, platformClaims('platform_support', 'aal2'));
    if (MANAGE.has(perm)) expect(code).toBe('auth.forbidden'); else expect(pastAuthz(code)).toBe(true);
  });

  it.each(table)('%s (%s): platform_support + aal1 never passes (manage codes: auth.forbidden; read/open codes: auth.mfa_required)', async (_id, perm, o) => {
    expect(await outcome(o, platformClaims('platform_support', 'aal1'))).toBe(MANAGE.has(perm) ? 'auth.forbidden' : 'auth.mfa_required');
  });

  it.each(table)('%s (%s): platform_superadmin + aal1 is refused auth.mfa_required', async (_id, _perm, o) => {
    expect(await outcome(o, platformClaims('platform_superadmin', 'aal1'))).toBe('auth.mfa_required');
  });
});

describe('other session kinds still cannot call a platform operation (sampled operation per platform.* code)', () => {
  const PER_CODE = CODES.map((c) => PLATFORM_OPS.find((o) => o.permission === c)!);
  const kinds: Array<[string, Record<string, unknown>]> = [
    ['tenant staff aal2', { sub: SUB, tenant_id: TENANT_A, actor_type: 'user', membership_id: STAFF, aal: 'aal2' }],
    ['tenant staff aal2 with a stray platform_role (no scope)', { sub: SUB, tenant_id: TENANT_A, actor_type: 'user', membership_id: STAFF, aal: 'aal2', platform_role: 'platform_superadmin' }],
    ['patient', { sub: SUB, tenant_id: TENANT_A, actor_type: 'patient', aal: 'aal2' }],
    ['partner with stray platform_role + scope platform', { sub: SUB, tenant_id: TENANT_A, actor_type: 'partner', aal: 'aal2', scope: 'platform', platform_role: 'platform_superadmin' }],
    ['support-session claims (scope support, no platform_role)', { sub: SUB, tenant_id: TENANT_A, actor_type: 'user', scope: 'support', support_session_id: STAFF, support_scope: 'read', platform_staff_id: STAFF, aal: 'aal2' }],
    ['platform claims without platform_role', { sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: STAFF, aal: 'aal2' }],
    ['platform claims, role without the platform_ prefix', { sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: STAFF, platform_role: 'superadmin', aal: 'aal2' }],
    ['platform claims, role tenant_admin', { sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: STAFF, platform_role: 'tenant_admin', aal: 'aal2' }],
  ];
  it.each(kinds)('%s -> auth.forbidden on every sampled platform operation', async (_n, claims) => {
    for (const o of PER_CODE) expect(await outcome(o, claims), o.operationId).toBe('auth.forbidden');
  });
});
