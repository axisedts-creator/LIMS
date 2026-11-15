// AUTH-ACTOR-2 (LD-222, AUTH-SENSITIVE; C2 02-TRD s7.4 + 01-PRD platform roles; C0 CR T0D-14; 08 A28.1): loadSessionActor fills actor.permissions ONLY for an ACTIVE session.
// Seam fixed here (the writer matches it or raises a dispute):
//   loadSessionActor(lookup, key, log, requestId, perms?: { state: string; tenantPermissions(membershipId: string): Promise<readonly string[]> })
//   - perms omitted, or state !== 'active'  -> NO `permissions` key at all (never [] either), tenantPermissions never called
//   - platform (key.tenantId === null), active -> permissionsOfRoles(actor roles) from domain/permission-set.ts (the set modules/identity/platform/authz.ts enforces); tenantPermissions never called
//   - tenant, active -> tenantPermissions(key.membershipId) = the core-repo membershipPermissions read (callers bind it to the tenant-bound tx); a throw / non-array / non-string entry -> LimsError common.internal
//   - the permission list and its codes are never logged and never in an error message
// Expected now: every `permissions` assertion fails (the loader has no 5th parameter and returns no permissions).
import { describe, expect, it, vi } from 'vitest';
import { ROLE_GRANTS } from '../../../../../../../contracts/ports/generated/permissions.js';
import { permissionsOfRoles } from '../../domain/permission-set.js';
import { loadSessionActor, type ActorKey } from '../session-actor.js';

const TENANT_KEY: ActorKey = { userId: 'user-1', tenantId: 'tenant-1', membershipId: 'memb-1' };
const PLATFORM_KEY: ActorKey = { userId: 'user-2', tenantId: null, membershipId: null };
const tenantRow = { display_name: 'Ana Demo', role_codes: ['lab_manager', 'technician'], tenant_code: 'lab_a' };
const platformRow = { display_name: 'Sam Staff', role_codes: ['platform_support'], tenant_code: null };
const SECRET_CODES = ['zz.sentinel.alpha', 'zz.sentinel.beta'];
const NOT_ACTIVE = ['password_setup', 'mfa_pending', 'mfa_enrolment_required'];

const mkLog = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() });
const logged = (l: ReturnType<typeof mkLog>) => JSON.stringify([l.error.mock.calls, l.info.mock.calls, l.warn.mock.calls]);
async function load(key: ActorKey, row: Record<string, unknown> | null | undefined, perms?: Parameters<typeof loadSessionActor>[4], log = mkLog()) {
  // the 5th parameter is the new seam; cast so this file compiles before the writer adds it
  return (loadSessionActor as any)(async () => row, key, log, 'req-1', perms) as Promise<{ display_name: string; roles: string[]; tenant_code?: string; permissions?: string[] }>;
}
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };

describe('tenant, ACTIVE: permissions = the membershipPermissions read', () => {
  it('returns the list the read returns, read once with the membership id of the key; actor fields unchanged', async () => {
    const read = vi.fn(async (_m: string) => ['lab.result.enter', 'lab.result.read']);
    const a = await load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: read } as any);
    expect(a.permissions).toEqual(['lab.result.enter', 'lab.result.read']);
    expect(read).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledWith('memb-1');
    expect(a).toMatchObject({ display_name: 'Ana Demo', roles: ['lab_manager', 'technician'], tenant_code: 'lab_a' });
    expect(Object.keys(a).sort()).toEqual(['display_name', 'permissions', 'roles', 'tenant_code']);
  });
  it('a successful read that returns [] is an honest empty array (a failed read is never an empty array)', async () => {
    const a = await load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: async () => [] } as any);
    expect(a.permissions).toEqual([]);
  });
  it('the returned array is a copy: mutating it cannot change what the read source holds', async () => {
    const src = ['a.b.read']; const a = await load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: async () => src } as any);
    a.permissions!.push('x.y.z'); expect(src).toEqual(['a.b.read']);
  });
  it('never emits a list the contract rejects: <= 400 entries of <= 100 chars (an oversize read is common.internal, not a silent truncation or an invalid 200)', async () => {
    const big = Array.from({ length: 401 }, (_, i) => `x.y.c${i}`);
    const out = await load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: async () => big } as any).then((a) => ({ a }), (e) => ({ e }));
    if ('a' in out) { expect(out.a.permissions!.length).toBeLessThanOrEqual(400); out.a.permissions!.forEach((c) => expect(c.length).toBeLessThanOrEqual(100)); }
    else expect((out.e as any).code).toBe('common.internal');
    const long = await load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: async () => ['x'.repeat(101)] } as any).then((a) => ({ a }), (e) => ({ e }));
    if ('a' in long) long.a.permissions!.forEach((c) => expect(c.length).toBeLessThanOrEqual(100)); else expect((long.e as any).code).toBe('common.internal');
  });
});

describe('tenant: a failed permission read is common.internal, never an empty list', () => {
  it.each([
    ['the read throws', async () => { throw new Error('connection reset by peer'); }],
    ['the read returns undefined', async () => undefined],
    ['the read returns null', async () => null],
    ['the read returns a non-array', async () => 'lab.result.read'],
    ['an entry is not a string', async () => ['lab.result.read', 42]],
  ])('%s -> LimsError common.internal, a log line, no permission code in the message or the log', async (_n, impl) => {
    const log = mkLog();
    const e = await rejection(load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: impl } as any, log));
    expect(e.code).toBe('common.internal');
    expect(log.error).toHaveBeenCalled();
    expect(JSON.stringify([e.message, e.detail ?? null, logged(log)])).not.toMatch(/lab\.result/);
  });
  it('a LimsError thrown by the read keeps being an error (never swallowed into permissions [])', async () => {
    const e = await rejection(load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: async () => { throw Object.assign(new Error('boom'), { code: 'common.dependency_unavailable' }); } } as any));
    expect(e).toBeInstanceOf(Error);
  });
  it('an active tenant key without a membership id cannot read permissions: common.internal (fail closed)', async () => {
    const e = await rejection(load({ ...TENANT_KEY, membershipId: null }, tenantRow, { state: 'active', tenantPermissions: async () => ['a.b.c'] } as any));
    expect(e.code).toBe('common.internal');
  });
  it('no actor row: common.internal as before, and the permission read is never attempted', async () => {
    const read = vi.fn(async () => ['a.b.c']);
    for (const row of [undefined, null, { ...tenantRow, display_name: '' }]) {
      const e = await rejection(load(TENANT_KEY, row as any, { state: 'active', tenantPermissions: read } as any)); expect(e.code).toBe('common.internal');
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe('platform, ACTIVE: permissions = permissionsOfRoles(actor roles) over the generated registry', () => {
  it('platform_support: the registry set, sorted, containing platform.tenant.read; the tenant read is never used', async () => {
    const read = vi.fn(async () => ['must.not.appear']);
    const a = await load(PLATFORM_KEY, platformRow, { state: 'active', tenantPermissions: read } as any);
    expect(a.permissions).toEqual(permissionsOfRoles(['platform_support']));
    expect(a.permissions).toContain('platform.tenant.read');
    expect([...a.permissions!].sort()).toEqual(a.permissions);
    expect(a.permissions).not.toContain('must.not.appear'); expect(read).not.toHaveBeenCalled();
    expect(a).not.toHaveProperty('tenant_code');
  });
  it('the platform.* part equals what PlatformAuthz enforces (ROLE_GRANTS) for EVERY platform role: the web never sees a code the API refuses, nor misses one it allows', async () => {
    const roles = Object.keys(ROLE_GRANTS as Record<string, readonly string[]>).filter((r) => r.startsWith('platform_'));
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const a = await load(PLATFORM_KEY, { ...platformRow, role_codes: [role] }, { state: 'active', tenantPermissions: async () => [] } as any);
      const granted = (ROLE_GRANTS as Record<string, readonly string[]>)[role]!.filter((c) => c.startsWith('platform.')).sort();
      expect(a.permissions!.filter((c) => c.startsWith('platform.')).sort(), role).toEqual(granted);
    }
  });
  it('an unknown platform role gets [] (fail closed), a role list is a union', async () => {
    expect((await load(PLATFORM_KEY, { ...platformRow, role_codes: ['ghost'] }, { state: 'active', tenantPermissions: async () => [] } as any)).permissions).toEqual([]);
    const both = await load(PLATFORM_KEY, { ...platformRow, role_codes: ['platform_support', 'platform_superadmin'] }, { state: 'active', tenantPermissions: async () => [] } as any);
    expect(both.permissions).toEqual(permissionsOfRoles(['platform_support', 'platform_superadmin']));
  });
});

describe('SECURITY RULE: no pre-MFA session learns its permission set', () => {
  it.each(NOT_ACTIVE)('state %s (tenant and platform): the `permissions` key is absent (not [], not undefined-valued) and no read happens', async (state) => {
    for (const [key, row] of [[TENANT_KEY, tenantRow], [PLATFORM_KEY, platformRow]] as const) {
      const read = vi.fn(async () => ['a.b.c']);
      const a = await load(key, row, { state, tenantPermissions: read } as any);
      expect(Object.keys(a)).not.toContain('permissions'); expect(read).not.toHaveBeenCalled();
      expect(JSON.stringify(a)).not.toContain('permissions');
    }
  });
  it.each(['revoked', 'expired', '', 'ACTIVE', 'Active'])('anything that is not exactly "active" (%j) gets no permissions', async (state) => {
    const read = vi.fn(async () => ['a.b.c']);
    expect(Object.keys(await load(TENANT_KEY, tenantRow, { state, tenantPermissions: read } as any))).not.toContain('permissions');
    expect(Object.keys(await load(PLATFORM_KEY, platformRow, { state, tenantPermissions: read } as any))).not.toContain('permissions');
    expect(read).not.toHaveBeenCalled();
  });
  it('the legacy 4-argument call (no perms) still yields the actor and NO permissions', async () => {
    const a = await load(TENANT_KEY, tenantRow, undefined);
    expect(a).toEqual({ display_name: 'Ana Demo', roles: ['lab_manager', 'technician'], tenant_code: 'lab_a' });
  });
});

describe('the list is never logged', () => {
  it('success (tenant and platform, active): nothing is logged at all, certainly not a code', async () => {
    const log = mkLog();
    await load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: async () => SECRET_CODES } as any, log);
    await load(PLATFORM_KEY, platformRow, { state: 'active', tenantPermissions: async () => SECRET_CODES } as any, log);
    expect(logged(log)).not.toContain('zz.sentinel'); expect(logged(log)).not.toContain('platform.tenant.read'); expect(logged(log)).not.toMatch(/permissions/i);
  });
  it('failure: the error and the log carry the request id only, not the codes the read returned before it failed validation', async () => {
    const log = mkLog();
    const e = await rejection(load(TENANT_KEY, tenantRow, { state: 'active', tenantPermissions: async () => [...SECRET_CODES, 7] } as any, log));
    expect(e.code).toBe('common.internal');
    expect(JSON.stringify([e.message, logged(log)])).not.toContain('zz.sentinel');
  });
});
