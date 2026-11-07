// T14 role.service (02-TRD §5.4; 03-APP-FLOW §4.3; 01-PRD AC-B2.1–B2.4; 07-SECURITY A-4, A-17, P-2, E-2). Seams: see role.helpers.ts header.
// Tester decisions where the spec is silent (flagged in .orchestra/notes/T14-tests.md):
//  * field-error pointer is `/permissions/<i>` (AC-B2.2 literal, same as domain validateRolePermissions) although the wire field is `permission_codes`;
//  * deactivateRole on the last admin role that still has members -> identity.last_admin_protected (checked BEFORE the member_count>0 version_conflict);
//  * fan-out = repo.revokeSessions(reason 'role_change') for every holder + `identity.gotrue_signout` jobs of <= 200 users each (03-APP-FLOW §4.3, 02-TRD §10).
import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY, isAssignable } from '../../domain/permission-set.js';
import { createRoleService } from '../role.service.js';
import { MANAGE, R_ADMIN, R_ADMIN2, R_B, R_FD, R_INACTIVE, TENANT_A, TENANT_B, idN, makeCtx, makeRepo, mem, rejection, role } from './role.helpers.js';

const privileged = DEFAULT_REGISTRY.filter((e) => e.privileged && isAssignable(e.code)).map((e) => e.code);
const plain = DEFAULT_REGISTRY.filter((e) => !e.privileged && isAssignable(e.code)).map((e) => e.code);
const PRIV = privileged.find((c) => c !== MANAGE)!, PLAIN = plain[0]!, PLAIN2 = plain[1]!;
const platformCode = DEFAULT_REGISTRY.find((e) => e.code.startsWith('platform.'))!.code;
const actorOnly = DEFAULT_REGISTRY.find((e) => !e.code.startsWith('platform.') && e.roles.length === 0)!.code;
const ALLOWED_KEYS = ['role_id', 'code', 'name', 'description', 'is_default', 'mfa_required', 'permission_codes', 'member_count', 'is_active', 'version'];
const REQUIRED_KEYS = ALLOWED_KEYS.filter((k) => k !== 'description');

const setup = (seed: Parameters<typeof makeRepo>[0] = {}, tenantId = TENANT_A) => {
  const r = makeRepo(seed);
  return { ...r, ...makeCtx({ tenantId }), svc: createRoleService({ repo: r.repo }) };
};
const adminSeed = () => ({
  roles: { [TENANT_A]: [role({ id: R_ADMIN, code: 'tenant_admin', is_system_default: true, mfa_required: true, permission_codes: [MANAGE, 'identity.user.read'], version: 2 }), role({ id: R_FD, code: 'front_desk' })], [TENANT_B]: [role({ id: R_B, code: 'tenant_admin' })] },
  mems: { [TENANT_A]: [mem({ id: idN(0x201), roleIds: [R_ADMIN] })] },
});
const createIn = (o: Record<string, unknown> = {}) => ({ code: 'phleb_lead', name: 'Phlebotomy lead', permissionCodes: [PLAIN], mfaRequired: false, ...o });
const updateIn = (o: Record<string, unknown> = {}) => ({ roleId: R_FD, expectedVersion: 1, name: 'Front desk', permissionCodes: ['identity.self.manage'], mfaRequired: false, ...o });
const shape = (b: any) => { expect(Object.keys(b).every((k) => ALLOWED_KEYS.includes(k))).toBe(true); expect(REQUIRED_KEYS.every((k) => k in b)).toBe(true); };

describe('listPermissions', () => {
  it('lists every registry code with {code, privileged, module, phase, assignable}; assignable=false for platform.* and actor-only codes', async () => {
    const { svc, ctx, writes } = setup();
    const r = await svc.listPermissions(ctx, {});
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(DEFAULT_REGISTRY.length);
    for (const p of r.body.data) {
      expect(Object.keys(p).sort()).toEqual(['assignable', 'code', 'module', 'phase', 'privileged']);
      const e = DEFAULT_REGISTRY.find((x) => x.code === p.code)!;
      expect(p.privileged).toBe(e.privileged); expect(p.module).toBe(p.code.split('.')[0]); expect(['1', '1.5', '2', '3']).toContain(p.phase);
      expect(p.assignable).toBe(isAssignable(p.code));
    }
    expect(r.body.data.find((p: any) => p.code === platformCode).assignable).toBe(false);
    expect(r.body.data.find((p: any) => p.code === actorOnly).assignable).toBe(false);
    expect(r.body.data.find((p: any) => p.code === MANAGE).assignable).toBe(true);
    expect(writes).toEqual([]);
  });
});

describe('listRoles / getRole', () => {
  it('listRoles returns Role-shaped rows of the caller tenant only; is_active filter passed through; name = display_name, is_default = is_system_default', async () => {
    const { svc, ctx, calls } = setup(adminSeed());
    const all = await svc.listRoles(ctx, {});
    expect(all.status).toBe(200); expect(all.body.data.map((x: any) => x.role_id).sort()).toEqual([R_ADMIN, R_FD].sort());
    all.body.data.forEach(shape);
    const a = all.body.data.find((x: any) => x.role_id === R_ADMIN);
    expect(a).toMatchObject({ code: 'tenant_admin', name: 'tenant_admin', is_default: true, mfa_required: true, member_count: 1, is_active: true, version: 2, permission_codes: [MANAGE, 'identity.user.read'] });
    expect(JSON.stringify(all.body)).not.toContain(R_B);
    await svc.listRoles(ctx, { isActive: false });
    expect(calls.filter((c) => c.m === 'listRoles').pop()!.args[0]).toEqual({ isActive: false });
  });
  it('getRole: 200 + version; unknown id and another tenant\'s id answer the same 404 common.not_found', async () => {
    const { svc, ctx } = setup(adminSeed());
    const ok = await svc.getRole(ctx, { roleId: R_ADMIN });
    expect(ok.status).toBe(200); expect(ok.version).toBe(2); shape(ok.body);
    const other = await rejection(svc.getRole(ctx, { roleId: R_B })); const rnd = await rejection(svc.getRole(ctx, { roleId: idN(0xfff) }));
    expect(other.code).toBe('common.not_found'); expect(rnd.code).toBe('common.not_found'); expect(other.detail).toEqual(rnd.detail);
  });
  it('a malformed roleId is rejected before any repo call', async () => {
    const { svc, ctx, calls } = setup(adminSeed());
    const e = await rejection(svc.getRole(ctx, { roleId: "x'; DROP TABLE core.roles;--" }));
    expect(['common.validation_failed', 'common.not_found']).toContain(e.code); expect(calls).toEqual([]);
  });
});

describe('createRole (AC-B2.1, AC-B2.2)', () => {
  it('201: stored under ctx.tenantId + actor id, id is a uuid, version 1, member_count 0, not default, active; access-log role.change', async () => {
    const { svc, ctx, calls, access, tx } = setup(adminSeed());
    const r = await svc.createRole(ctx, createIn({ description: 'Draws blood' }));
    expect(r.status).toBe(201); expect(r.version).toBe(1); shape(r.body);
    expect(r.body).toMatchObject({ code: 'phleb_lead', name: 'Phlebotomy lead', description: 'Draws blood', is_default: false, member_count: 0, is_active: true, version: 1, permission_codes: [PLAIN] });
    const ins = calls.find((c) => c.m === 'insertRole')!;
    expect(ins.tenantId).toBe(TENANT_A); expect(ins.tx).toBe(tx); expect((ins.args[0] as any).actorId).toBe(ctx.actor.id);
    expect((ins.args[0] as any).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(access).toHaveBeenCalledTimes(1);
    expect(access.mock.calls[0]![0]).toMatchObject({ action: 'role.change', entityType: 'role', entityId: r.body.role_id, outcome: 'allowed' });
  });
  it('AC-B2.1 a privileged permission forces mfa_required = true even when the submitted flag is false (stored AND returned)', async () => {
    const { svc, ctx, calls } = setup(adminSeed());
    const r = await svc.createRole(ctx, createIn({ permissionCodes: [PLAIN, PRIV], mfaRequired: false }));
    expect(r.body.mfa_required).toBe(true); expect((calls.find((c) => c.m === 'insertRole')!.args[0] as any).mfaRequired).toBe(true);
  });
  it.each([[false, false], [true, true]])('no privileged permission: submitted mfa_required %s is kept (%s)', async (sent, stored) => {
    const { svc, ctx } = setup(adminSeed());
    expect((await svc.createRole(ctx, createIn({ permissionCodes: [PLAIN], mfaRequired: sent }))).body.mfa_required).toBe(stored);
  });
  it('AC-B2.2 platform.*, actor-only and unknown codes -> 400 common.validation_failed, errors[] code common.field_invalid at /permissions/<i> for EACH offender; nothing written', async () => {
    const { svc, ctx, writes, access } = setup(adminSeed());
    const e = await rejection(svc.createRole(ctx, createIn({ permissionCodes: [PLAIN, platformCode, actorOnly, 'nope.made_up', PLAIN2] })));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    expect(e.errors.map((x: any) => [x.path, x.code])).toEqual([['/permissions/1', 'common.field_invalid'], ['/permissions/2', 'common.field_invalid'], ['/permissions/3', 'common.field_invalid']]);
    expect(writes).toEqual([]); expect(access).not.toHaveBeenCalled();
  });
  it('A-4 privilege escalation: a "superuser" role carrying platform.tenant.manage is refused, also when mixed with valid codes', async () => {
    const { svc, ctx, writes } = setup(adminSeed());
    const e = await rejection(svc.createRole(ctx, createIn({ code: 'superuser', permissionCodes: [MANAGE, 'platform.tenant.manage'] })));
    expect(e.code).toBe('common.validation_failed'); expect(writes).toEqual([]);
  });
  it('non-string / empty / oversize permission list is a validation error, never a crash', async () => {
    const { svc, ctx, writes } = setup(adminSeed());
    for (const permissionCodes of [[], [42], [null], [{}], 'identity.self.manage', undefined, Array.from({ length: 201 }, () => PLAIN)]) {
      const e = await rejection(svc.createRole(ctx, createIn({ permissionCodes })));
      expect(e.code).toBe('common.validation_failed');
    }
    expect(writes).toEqual([]);
  });
  it('duplicate permission codes never produce a 500: stored once or rejected as validation_failed', async () => {
    const { svc, ctx } = setup(adminSeed());
    try { const r = await svc.createRole(ctx, createIn({ permissionCodes: [PLAIN, PLAIN] })); expect(r.body.permission_codes).toEqual([PLAIN]); }
    catch (e: any) { expect(e.code).toBe('common.validation_failed'); }
  });
  it.each([['Front_Desk'], ['1abc'], ['a'], ['x'.repeat(41)], [''], ['has space'], ['tenant-admin']])('bad role code %j -> 400 common.validation_failed, nothing written', async (code) => {
    const { svc, ctx, writes } = setup(adminSeed());
    expect((await rejection(svc.createRole(ctx, createIn({ code })))).code).toBe('common.validation_failed'); expect(writes).toEqual([]);
  });
  it.each([[{ name: '' }], [{ name: 'x'.repeat(81) }], [{ description: 'x'.repeat(501) }], [{ mfaRequired: 'yes' }], [{ mfaRequired: undefined }]])('bad field %j -> 400', async (patch) => {
    const { svc, ctx, writes } = setup(adminSeed());
    expect((await rejection(svc.createRole(ctx, createIn(patch)))).code).toBe('common.validation_failed'); expect(writes).toEqual([]);
  });
  it('duplicate code in the tenant (pg 23505) -> 409 identity.code_duplicate, no access-log "allowed" entry', async () => {
    const { svc, ctx, access } = setup(adminSeed());
    const e = await rejection(svc.createRole(ctx, createIn({ code: 'front_desk' })));
    expect(e.code).toBe('identity.code_duplicate'); expect(e.statusCode).toBe(409); expect(access).not.toHaveBeenCalled();
  });
  it('a code used only in ANOTHER tenant is not a duplicate (201); the caller tenant own code is (409)', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk' })], [TENANT_B]: [role({ id: R_B, code: 'b_only_role' })] } });
    expect((await s.svc.createRole(s.ctx, createIn({ code: 'b_only_role' }))).status).toBe(201);
    expect((await rejection(s.svc.createRole(s.ctx, createIn({ code: 'front_desk' })))).code).toBe('identity.code_duplicate');
  });
  it('mass assignment: tenantId / isDefault / role_id / version in the input never reach the repo', async () => {
    const { svc, ctx, calls } = setup(adminSeed());
    await svc.createRole(ctx, { ...createIn(), tenantId: TENANT_B, tenant_id: TENANT_B, isDefault: true, is_system_default: true, id: R_B, version: 9, permissions: [platformCode] });
    const ins = calls.find((c) => c.m === 'insertRole')!;
    expect(ins.tenantId).toBe(TENANT_A); expect(ins.args[0]).not.toMatchObject({ id: R_B }); expect(JSON.stringify(ins.args[0])).not.toContain(TENANT_B); expect(ins.args[0]).not.toHaveProperty('isDefault');
  });
  it('a failing repo write surfaces (rolls back the request tx) and writes no access-log entry', async () => {
    const { svc, ctx, access, fail } = setup(adminSeed()); fail['insertRole'] = new Error('db down');
    await rejection(svc.createRole(ctx, createIn())); expect(access).not.toHaveBeenCalled();
  });
});

describe('updateRole (AC-B2.1, AC-B2.2, AC-B2.4)', () => {
  it('200: replaces name/description/permissions, version + 1, ETag source; PUT without description clears it; access-log role.change', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk', description: 'old' })] } });
    const r = await s.svc.updateRole(s.ctx, updateIn({ name: 'Reception', permissionCodes: [PLAIN, PLAIN2] }));
    expect(r.status).toBe(200); expect(r.version).toBe(2); shape(r.body);
    expect(r.body).toMatchObject({ role_id: R_FD, code: 'front_desk', name: 'Reception', version: 2 }); expect(r.body.description).toBeUndefined();
    expect([...r.body.permission_codes].sort()).toEqual([PLAIN, PLAIN2].sort());
    expect(s.access.mock.calls[0]![0]).toMatchObject({ action: 'role.change', entityType: 'role', entityId: R_FD, outcome: 'allowed' });
  });
  it('code is immutable: input `code` is ignored', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk' })] } });
    expect((await s.svc.updateRole(s.ctx, { ...updateIn(), code: 'hijacked' })).body.code).toBe('front_desk');
  });
  it('AC-B2.1 adding a privileged code forces mfa_required true; updating a privileged role with mfaRequired:false cannot downgrade it', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk' })] } });
    const r = await s.svc.updateRole(s.ctx, updateIn({ permissionCodes: [PLAIN, PRIV], mfaRequired: false }));
    expect(r.body.mfa_required).toBe(true);
    const again = await s.svc.updateRole(s.ctx, updateIn({ expectedVersion: 2, permissionCodes: [PRIV], mfaRequired: false }));
    expect(again.body.mfa_required).toBe(true);
  });
  it('AC-B2.2 non-assignable codes -> 400 with /permissions/<i>; nothing written, no fan-out', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk' })] }, mems: { [TENANT_A]: [mem({ id: idN(0x210), roleIds: [R_FD] })] } });
    const e = await rejection(s.svc.updateRole(s.ctx, updateIn({ permissionCodes: [platformCode, PLAIN, actorOnly] })));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toEqual(['/permissions/0', '/permissions/2']);
    expect(s.writes).toEqual([]); expect(s.access).not.toHaveBeenCalled();
  });
  it('unknown role and another tenant\'s role -> identical 404, nothing written', async () => {
    const s = setup(adminSeed());
    for (const roleId of [R_B, idN(0xfff)]) expect((await rejection(s.svc.updateRole(s.ctx, updateIn({ roleId })))).code).toBe('common.not_found');
    expect(s.writes).toEqual([]);
  });
  it('missing If-Match -> 428 common.precondition_required; 0 / negative / fractional / string -> 400; stale -> 409 common.version_conflict; none writes', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk', version: 3 })] } });
    expect((await rejection(s.svc.updateRole(s.ctx, updateIn({ expectedVersion: undefined })))).code).toBe('common.precondition_required');
    for (const v of [0, -1, 1.5, '3']) expect((await rejection(s.svc.updateRole(s.ctx, updateIn({ expectedVersion: v })))).code).toBe('common.validation_failed');
    expect((await rejection(s.svc.updateRole(s.ctx, updateIn({ expectedVersion: 2 })))).code).toBe('common.version_conflict');
    expect(s.roleRow(TENANT_A, R_FD)!.version).toBe(3); expect(s.writes.filter((w) => w !== 'updateRole')).toEqual([]);
  });
  it('a lost race (repo.updateRole -> undefined) is 409 common.version_conflict with no fan-out and no access-log entry', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk' })] }, mems: { [TENANT_A]: [mem({ id: idN(0x210), roleIds: [R_FD] })] } });
    s.repo.updateRole = async () => undefined;
    expect((await rejection(s.svc.updateRole(s.ctx, updateIn({ permissionCodes: [PLAIN2] })))).code).toBe('common.version_conflict');
    expect(s.writes).not.toContain('revokeSessions'); expect(s.writes).not.toContain('enqueueJob'); expect(s.access).not.toHaveBeenCalled();
  });
  it('mass assignment: input tenantId never changes the tenant the repo is called with', async () => {
    const s = setup(adminSeed());
    await s.svc.updateRole(s.ctx, { ...updateIn(), tenantId: TENANT_B, isDefault: false });
    expect(new Set(s.calls.filter((c) => c.m !== 'enqueueJob').map((c) => c.tenantId))).toEqual(new Set([TENANT_A]));
  });
});

describe('last admin protection (AC-B2.3, 03-APP-FLOW §4.3, A-17, E-2)', () => {
  const sole = () => adminSeed();
  const dropManage = { roleId: R_ADMIN, expectedVersion: 2, name: 'Tenant admin', permissionCodes: ['identity.user.read'], mfaRequired: true };

  it('removing identity.role.manage from the role of the only active holder -> 409 identity.last_admin_protected; DB unchanged, no revoke, no job, no audit entry', async () => {
    const s = setup(sole());
    const e = await rejection(s.svc.updateRole(s.ctx, dropManage));
    expect(e.code).toBe('identity.last_admin_protected'); expect(e.statusCode).toBe(409);
    expect(s.roleRow(TENANT_A, R_ADMIN)!.permission_codes).toContain(MANAGE); expect(s.roleRow(TENANT_A, R_ADMIN)!.version).toBe(2);
    expect(s.writes).toEqual([]); expect(s.access).not.toHaveBeenCalled();
  });
  it('keeping identity.role.manage in the set is not a last-admin case (other permissions may change)', async () => {
    const s = setup(sole());
    expect((await s.svc.updateRole(s.ctx, { ...dropManage, permissionCodes: [MANAGE, PLAIN] })).status).toBe(200);
  });
  it('another ACTIVE, unlocked holder through another active role -> removal allowed', async () => {
    const seed = sole(); seed.roles[TENANT_A].push(role({ id: R_ADMIN2, code: 'second_admin', permission_codes: [MANAGE] })); seed.mems[TENANT_A].push(mem({ id: idN(0x202), roleIds: [R_ADMIN2] }));
    const s = setup(seed);
    expect((await s.svc.updateRole(s.ctx, dropManage)).status).toBe(200);
  });
  it('the same membership also holding a second role that grants role.manage keeps its admin power -> allowed', async () => {
    const seed = sole(); seed.roles[TENANT_A].push(role({ id: R_ADMIN2, code: 'second_admin', permission_codes: [MANAGE] })); seed.mems[TENANT_A][0]!.roleIds.push(R_ADMIN2);
    const s = setup(seed);
    expect((await s.svc.updateRole(s.ctx, dropManage)).status).toBe(200);
  });
  it.each([
    ['locked', { locked: true }], ['deactivated', { status: 'deactivated' as const }], ['invited (never accepted)', { status: 'invited' as const }],
  ])('the "other admin" is %s -> does not count -> 409 identity.last_admin_protected', async (_n, patch) => {
    const seed = sole(); seed.roles[TENANT_A].push(role({ id: R_ADMIN2, code: 'second_admin', permission_codes: [MANAGE] })); seed.mems[TENANT_A].push(mem({ id: idN(0x202), roleIds: [R_ADMIN2], ...patch }));
    const s = setup(seed);
    expect((await rejection(s.svc.updateRole(s.ctx, dropManage))).code).toBe('identity.last_admin_protected');
  });
  it('the "other admin" holds role.manage only through an INACTIVE role -> does not count', async () => {
    const seed = sole(); seed.roles[TENANT_A].push(role({ id: R_INACTIVE, code: 'old_admin', is_active: false, permission_codes: [MANAGE] })); seed.mems[TENANT_A].push(mem({ id: idN(0x203), roleIds: [R_INACTIVE] }));
    const s = setup(seed);
    expect((await rejection(s.svc.updateRole(s.ctx, dropManage))).code).toBe('identity.last_admin_protected');
  });
  it('a non-user actor (partner/patient) membership never counts as an admin', async () => {
    const seed = sole(); seed.roles[TENANT_A].push(role({ id: R_ADMIN2, code: 'second_admin', permission_codes: [MANAGE] })); seed.mems[TENANT_A].push(mem({ id: idN(0x204), roleIds: [R_ADMIN2], actorType: 'partner' }));
    const s = setup(seed);
    expect((await rejection(s.svc.updateRole(s.ctx, dropManage))).code).toBe('identity.last_admin_protected');
  });
  it('the role to be changed has no active holder (nobody loses admin power) -> allowed', async () => {
    const seed = sole(); seed.mems[TENANT_A][0]!.status = 'deactivated';
    const s = setup(seed);
    expect((await s.svc.updateRole(s.ctx, dropManage)).status).toBe(200);
  });
  it('deactivateRole of the only role granting role.manage to the last admin -> 409 identity.last_admin_protected (even though member_count > 0 would also conflict)', async () => {
    const seed = sole(); seed.roles[TENANT_A][0]!.is_system_default = false;   // custom admin role
    const s = setup(seed);
    const e = await rejection(s.svc.deactivateRole(s.ctx, { roleId: R_ADMIN, expectedVersion: 2 }));
    expect(e.code).toBe('identity.last_admin_protected'); expect(s.roleRow(TENANT_A, R_ADMIN)!.is_active).toBe(true); expect(s.writes).toEqual([]);
  });
  it('the check is tenant-scoped: another tenant\'s admins never satisfy it', async () => {
    const seed = sole(); seed.mems[TENANT_B] = [mem({ id: idN(0x2b1), roleIds: [R_B] })]; seed.roles[TENANT_B] = [role({ id: R_B, code: 'tenant_admin', permission_codes: [MANAGE] })];
    const s = setup(seed);
    expect((await rejection(s.svc.updateRole(s.ctx, dropManage))).code).toBe('identity.last_admin_protected');
  });
});

describe('deactivateRole', () => {
  it('unused custom role -> 200 is_active=false, version + 1, access-log role.change; no member -> no session fan-out', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk', version: 4 })] } });
    const r = await s.svc.deactivateRole(s.ctx, { roleId: R_FD, expectedVersion: 4 });
    expect(r.status).toBe(200); expect(r.version).toBe(5); expect(r.body).toMatchObject({ is_active: false, version: 5 }); shape(r.body);
    expect(s.access.mock.calls[0]![0]).toMatchObject({ action: 'role.change', entityType: 'role', entityId: R_FD, outcome: 'allowed' });
    expect(s.writes).not.toContain('revokeSessions');
  });
  it('default (system) role -> 409 common.version_conflict with detail "default role"; unchanged', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk', is_system_default: true })] } });
    const e = await rejection(s.svc.deactivateRole(s.ctx, { roleId: R_FD, expectedVersion: 1 }));
    expect(e.code).toBe('common.version_conflict'); expect(e.detail).toBe('default role'); expect(s.writes).toEqual([]);
  });
  it('role with members (not an admin role) -> 409 common.version_conflict; unchanged', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk' })] }, mems: { [TENANT_A]: [mem({ id: idN(0x210), roleIds: [R_FD] })] } });
    const e = await rejection(s.svc.deactivateRole(s.ctx, { roleId: R_FD, expectedVersion: 1 }));
    expect(e.code).toBe('common.version_conflict'); expect(s.roleRow(TENANT_A, R_FD)!.is_active).toBe(true); expect(s.writes).toEqual([]);
  });
  it('missing If-Match -> 428; stale -> 409 common.version_conflict; unknown / foreign role -> 404', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk', version: 2 })], [TENANT_B]: [role({ id: R_B, code: 'x1' })] } });
    expect((await rejection(s.svc.deactivateRole(s.ctx, { roleId: R_FD, expectedVersion: undefined }))).code).toBe('common.precondition_required');
    expect((await rejection(s.svc.deactivateRole(s.ctx, { roleId: R_FD, expectedVersion: 1 }))).code).toBe('common.version_conflict');
    for (const roleId of [R_B, idN(0xfff)]) expect((await rejection(s.svc.deactivateRole(s.ctx, { roleId, expectedVersion: 1 }))).code).toBe('common.not_found');
    expect(s.roleRow(TENANT_A, R_FD)!.is_active).toBe(true); expect(s.roleRow(TENANT_B, R_B)!.is_active).toBe(true);
  });
});

describe('session fan-out revoke on role change (done_when; AC-B2.4; 03-APP-FLOW §4.3 SS9 role_change)', () => {
  const holders = (n: number) => Array.from({ length: n }, (_, i) => mem({ id: idN(0x1000 + i), userId: idN(0x9000 + i), roleIds: [R_FD] }));
  const withHolders = (n: number) => setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk', permission_codes: [PLAIN] })] }, mems: { [TENANT_A]: holders(n) } });
  const change = { permissionCodes: [PLAIN, PLAIN2] };

  it('a permission-set change revokes the sessions of EVERY holder with reason role_change, in the request tx and tenant', async () => {
    const s = withHolders(3);
    await s.svc.updateRole(s.ctx, updateIn(change));
    const rev = s.calls.filter((c) => c.m === 'revokeSessions');
    expect(rev.length).toBeGreaterThan(0);
    expect(rev.every((c) => c.tx === s.tx && c.tenantId === TENANT_A && c.args[1] === 'role_change')).toBe(true);
    expect(rev.flatMap((c) => c.args[0] as string[]).sort()).toEqual(holders(3).map((m) => m.id).sort());
  });
  it('revoke runs AFTER the role update succeeded and fan-out jobs after the revoke', async () => {
    const s = withHolders(2);
    await s.svc.updateRole(s.ctx, updateIn(change));
    const order = s.calls.map((c) => c.m);
    expect(order.indexOf('updateRole')).toBeLessThan(order.indexOf('revokeSessions')); expect(order.indexOf('revokeSessions')).toBeLessThan(order.indexOf('enqueueJob'));
  });
  it('450 holders -> identity.gotrue_signout jobs of <= 200 users each (200+200+50), every user exactly once, distinct job keys naming role_change', async () => {
    const s = withHolders(450);
    await s.svc.updateRole(s.ctx, updateIn(change));
    const jobs = s.calls.filter((c) => c.m === 'enqueueJob').map((c) => c.args[0] as { taskIdentifier: string; payload: unknown; jobKey: string });
    expect(jobs.every((j) => j.taskIdentifier === 'identity.gotrue_signout')).toBe(true);
    expect(new Set(jobs.map((j) => j.jobKey)).size).toBe(jobs.length); expect(jobs.every((j) => /^signout:.*role_change/.test(j.jobKey))).toBe(true);
    const sizes = jobs.map((j) => holders(450).filter((m) => JSON.stringify(j.payload).includes(m.userId)).length).sort((a, b) => b - a);
    expect(sizes).toEqual([200, 200, 50]);
    const all = holders(450).map((m) => m.userId);
    for (const u of all) expect(jobs.filter((j) => JSON.stringify(j.payload).includes(u))).toHaveLength(1);
    expect(s.calls.filter((c) => c.m === 'revokeSessions').flatMap((c) => c.args[0] as string[])).toHaveLength(450);
  });
  it('no change to the permission SET (name/description only, or the same codes re-ordered) -> no revoke, no job', async () => {
    const s = withHolders(3);
    await s.svc.updateRole(s.ctx, updateIn({ name: 'Renamed', description: 'x', permissionCodes: [PLAIN] }));
    const s2 = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk', permission_codes: [PLAIN, PLAIN2] })] }, mems: { [TENANT_A]: holders(3) } });
    await s2.svc.updateRole(s2.ctx, updateIn({ permissionCodes: [PLAIN2, PLAIN] }));
    for (const x of [s, s2]) { expect(x.writes).not.toContain('revokeSessions'); expect(x.writes).not.toContain('enqueueJob'); }
  });
  it('removing a permission also fans out (shrinking is a change)', async () => {
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk', permission_codes: [PLAIN, PLAIN2] })] }, mems: { [TENANT_A]: holders(2) } });
    await s.svc.updateRole(s.ctx, updateIn({ permissionCodes: [PLAIN] }));
    expect(s.writes).toContain('revokeSessions');
  });
  it('only the holders of THIS role in THIS tenant are touched', async () => {
    const other = mem({ id: idN(0x7777), roleIds: [R_ADMIN2] });
    const s = setup({ roles: { [TENANT_A]: [role({ id: R_FD, code: 'front_desk' }), role({ id: R_ADMIN2, code: 'other' })], [TENANT_B]: [] }, mems: { [TENANT_A]: [...holders(2), other], [TENANT_B]: [mem({ id: idN(0x8888), roleIds: [R_FD] })] } });
    await s.svc.updateRole(s.ctx, updateIn(change));
    const ids = s.calls.filter((c) => c.m === 'revokeSessions').flatMap((c) => c.args[0] as string[]);
    expect(ids).not.toContain(other.id); expect(ids).not.toContain(idN(0x8888)); expect(ids).toHaveLength(2);
  });
  it('if the revoke or the job enqueue fails the error propagates (request tx rolls back) and no "allowed" access-log entry is written', async () => {
    for (const m of ['revokeSessions', 'enqueueJob'] as const) {
      const s = withHolders(2); s.fail[m] = new Error('boom');
      await rejection(s.svc.updateRole(s.ctx, updateIn(change))); expect(s.access).not.toHaveBeenCalled();
    }
  });
  it('createRole never fans out (a new role has no holders)', async () => {
    const s = withHolders(2); await s.svc.createRole(s.ctx, createIn());
    expect(s.writes).not.toContain('revokeSessions');
  });
});

describe('every repo call is tenant-bound to ctx.tenantId and the request tx (REQ-SEC-040)', () => {
  it('a full create -> update -> deactivate run only ever uses TENANT_A and ctx.tx', async () => {
    const s = setup(adminSeed());
    const c = await s.svc.createRole(s.ctx, createIn());
    const u = await s.svc.updateRole(s.ctx, { roleId: c.body.role_id, expectedVersion: 1, name: 'n', permissionCodes: [PLAIN, PLAIN2], mfaRequired: false });
    await s.svc.deactivateRole(s.ctx, { roleId: c.body.role_id, expectedVersion: u.version });
    await s.svc.listRoles(s.ctx, {}); await s.svc.getRole(s.ctx, { roleId: R_ADMIN });
    expect(s.calls.length).toBeGreaterThan(5);
    expect(s.calls.filter((x) => x.m !== 'enqueueJob').every((x) => x.tenantId === TENANT_A && x.tx === s.tx)).toBe(true);
  });
});
