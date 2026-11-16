// ADMINPACK-3 (LD-262, LD-254, LD-189; 11-ROLE-MATRIX R5a, R6): add the permissions a pack gained to a role the lab ALREADY has.
// Explicit per role, dry run first, additive only. Synthetic data only.
// ASSUMED API (the brief leaves the seam open; the writer must match it or raise a dispute):
//   svc.applyRolePack(ctx, { packCode }, addMissing?: { roles: string[]; yes: boolean })      // 3rd argument optional; absent = default behaviour, byte-for-byte unchanged
//   With addMissing: ONLY the named roles are looked at (no role is created, no other role touched). Result body = the default body
//   { pack_code, created: [], updated: <codes of roles that got permissions, [] on a dry run>, unchanged: <rest> } PLUS
//   add_missing: Array<{ role_code, missing: string[] (pack has, lab role lacks; sorted), extra: string[] (lab role has, pack lacks; sorted, informational), added: string[] (sorted; [] on a dry run) }>   in the order given.
//   yes=false: NOTHING written, NO audit entry. yes=true: repo.addPermissions(tx, tenant, roleId, <missing sorted>, actorId) once per changed role,
//   one ctx.audit.access({ action:'role.change', entityType:'role', entityId:<role id>, outcome:'allowed' }) per changed role, none for an unchanged role.
//   Refusals (LimsError 'common.validation_failed', checked BEFORE any write, so a multi-role request is all-or-nothing): role not in the selected pack,
//   role the lab does not have, empty / non-string / duplicate-free list violations, yes=true with no roles, a permission code not in the registry,
//   and (yes=true) a privileged permission to be added to a role whose mfa_required is false. Existing guards (auth.unauthenticated, common.internal) apply first.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { DEFAULT_REGISTRY, isAssignable } from '../../domain/permission-set.js';
import { createRolePackRepo, createRolePackService } from '../../service/role-pack.service.js';

const hoisted = vi.hoisted(() => ({ override: undefined as any }));
vi.mock('../../role-packs/loader.js', async (importOriginal) => {
  const o = await importOriginal<any>();
  return { ...o, loadRolePacks: () => hoisted.override ?? o.loadRolePacks() };
});

type PackRole = { code: string; name: string; mfa_required: boolean; permissions: string[] };
type Pack = { code: string; roles: PackRole[] };
const IDENTITY = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');
const packsFile = parse(readFileSync(join(IDENTITY, 'role-packs', 'role-packs.data.yaml'), 'utf8')) as { packs: Pack[] };
const PACK = (code: string): Pack => packsFile.packs.find((p) => p.code === code)!;
const CORP = PACK('elabcorp_default'), STD = PACK('elabassist_standard');
const pr = (pack: Pack, code: string) => pack.roles.find((r) => r.code === code)!;
const sorted = (a: readonly string[]) => [...new Set(a)].sort();
const isPriv = (c: string) => DEFAULT_REGISTRY.find((e) => e.code === c)?.privileged === true;

const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1), ACTOR = idN(0xd1), TX = { tx: 'request-tx' };
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

type Row = { id: string; code: string; is_system_default: boolean; is_active: boolean; mfa_required: boolean; display_name: string; permission_codes: string[] };
const row = (o: Partial<Row> & { id: string; code: string }): Row => ({ is_system_default: false, is_active: true, mfa_required: false, display_name: o.code, permission_codes: [], ...o });
const DEFAULTS = (): Row[] => [
  row({ id: idN(0x201), code: 'tenant_admin', is_system_default: true, mfa_required: true, permission_codes: ['identity.role.manage', 'identity.user.manage'] }),
  row({ id: idN(0x202), code: 'pathologist', is_system_default: true, permission_codes: ['identity.self.manage'] }),
];

function makeRepo(seed: Record<string, Row[]>) {
  const roles = new Map(Object.entries(seed).map(([t, rs]) => [t, rs.map((r) => ({ ...r, permission_codes: [...r.permission_codes] }))]));
  const calls: Array<{ m: string; tx: unknown; tenantId: string; args: unknown[] }> = [];
  const writes: Array<{ m: string; tenantId: string; arg: any }> = [];
  const of = (t: string) => roles.get(t) ?? roles.set(t, []).get(t)!;
  const repo = {
    async listRoles(tx: unknown, tenantId: string) { calls.push({ m: 'listRoles', tx, tenantId, args: [] }); return structuredClone(of(tenantId)); },
    async insertRole(tx: unknown, tenantId: string, r: any) { calls.push({ m: 'insertRole', tx, tenantId, args: [r] }); writes.push({ m: 'insertRole', tenantId, arg: r }); of(tenantId).push(row({ id: r.id, code: r.code, permission_codes: r.permissionCodes })); },
    async addPermissions(tx: unknown, tenantId: string, roleId: string, codes: string[], actorId: string) {
      calls.push({ m: 'addPermissions', tx, tenantId, args: [roleId, codes, actorId] }); writes.push({ m: 'addPermissions', tenantId, arg: { roleId, codes, actorId } });
      const r = of(tenantId).find((x) => x.id === roleId)!; r.permission_codes = sorted([...r.permission_codes, ...codes]);
    },
  };
  return { repo, roles, of, calls, writes };
}
function ctxOf(o: Record<string, unknown> = {}) {
  const access = vi.fn(async (_e: Record<string, unknown>) => undefined);
  return { ctx: { tenantId: TENANT_A, actor: { type: 'user', id: ACTOR }, requestId: idN(0xe1), tx: TX, audit: { access }, ...o } as any, access };
}
let seq = 0x5000;
const setup = (seed: Record<string, Row[]>) => { const w = makeRepo(seed); return { ...w, svc: createRolePackService({ repo: w.repo, newId: () => idN(seq++) }), ...ctxOf() }; };

// ---- fixtures: a lab provisioned BEFORE R5a (old, shorter corp_admin the lab also edited) -------------------------------------------------
const ADMIN = pr(CORP, 'corp_admin');
const MISSING = sorted(ADMIN.permissions).slice(-6);                       // what the pack "gained"
const HAS = sorted(ADMIN.permissions).filter((c) => !MISSING.includes(c));
const EXTRA = DEFAULT_REGISTRY.map((e) => e.code).find((c) => isAssignable(c) && !ADMIN.permissions.includes(c))!;   // a code the lab added itself
const OLD_ADMIN = () => row({ id: idN(0x401), code: 'corp_admin', display_name: 'Lab owner', mfa_required: true, permission_codes: sorted([...HAS, EXTRA]) });
const lab = (...rs: Row[]) => ({ [TENANT_A]: [...DEFAULTS(), ...rs], [TENANT_B]: DEFAULTS() });
const ROLES = (roles: string[], yes: boolean) => ({ roles, yes });

describe('ADMINPACK-3 fixtures are meaningful', () => {
  it('the pack role is wide, the lab role lacks some, the lab added one code the pack does not have', () => {
    expect(MISSING).toHaveLength(6); expect(HAS.length).toBeGreaterThan(20); expect(EXTRA).toBeTruthy(); expect(ADMIN.permissions).not.toContain(EXTRA);
    expect(ADMIN.mfa_required).toBe(true);
  });
});

describe('ADMINPACK-3 dry run (no --yes) writes nothing', () => {
  it('lists, per role, what would be added and what only the lab has; no write, no audit, state identical', async () => {
    const { svc, ctx, access, roles, writes } = setup(lab(OLD_ADMIN()));
    const before = structuredClone([...roles.entries()]);
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], false));
    expect(writes).toEqual([]); expect(access).not.toHaveBeenCalled(); expect([...roles.entries()]).toEqual(before);
    expect((r.body as any).add_missing).toEqual([{ role_code: 'corp_admin', missing: MISSING, extra: [EXTRA], added: [] }]);
    expect(r.body).toMatchObject({ pack_code: 'elabcorp_default', created: [], updated: [] });
  });
});

describe('ADMINPACK-3 --yes adds exactly the missing set, additive only', () => {
  it('addPermissions once with exactly the missing codes (sorted) for the ctx tenant / tx / actor; extras kept; nothing else about the role changes', async () => {
    const { svc, ctx, of, calls, writes } = setup(lab(OLD_ADMIN()));
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
    expect(writes).toEqual([{ m: 'addPermissions', tenantId: TENANT_A, arg: { roleId: idN(0x401), codes: MISSING, actorId: ACTOR } }]);
    for (const c of calls) { expect(c.tx).toBe(TX); expect(c.tenantId).toBe(TENANT_A); }
    const after = of(TENANT_A).find((x) => x.code === 'corp_admin')!;
    expect(after.permission_codes).toEqual(sorted([...ADMIN.permissions, EXTRA]));
    expect(after).toMatchObject({ id: idN(0x401), display_name: 'Lab owner', mfa_required: true, is_active: true, is_system_default: false });
    expect((r.body as any).add_missing).toEqual([{ role_code: 'corp_admin', missing: MISSING, extra: [EXTRA], added: MISSING }]);
    expect(r.body).toMatchObject({ created: [], updated: ['corp_admin'] });
  });

  it('std_admin works the same way on the other pack', async () => {
    const A = pr(STD, 'std_admin'); const miss = sorted(A.permissions).slice(-4); const has = sorted(A.permissions).filter((c) => !miss.includes(c));
    const { svc, ctx, of, writes } = setup(lab(row({ id: idN(0x402), code: 'std_admin', mfa_required: true, permission_codes: has })));
    await svc.applyRolePack(ctx, { packCode: 'elabassist_standard' }, ROLES(['std_admin'], true));
    expect(writes.map((w) => w.arg.codes)).toEqual([miss]); expect(of(TENANT_A).find((x) => x.code === 'std_admin')!.permission_codes).toEqual(sorted(A.permissions));
  });

  it('one audit event per changed role: action role.change, entity role, the lab role id, allowed; no personal data', async () => {
    const { svc, ctx, access } = setup(lab(OLD_ADMIN()));
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
    expect(access.mock.calls).toHaveLength(1);
    expect(access.mock.calls[0]![0]).toMatchObject({ action: 'role.change', entityType: 'role', entityId: idN(0x401), outcome: 'allowed' });
    expect(JSON.stringify(access.mock.calls)).not.toContain('@');
  });

  it('is idempotent: the second run adds nothing, audits nothing, state identical', async () => {
    const { svc, ctx, access, roles, writes } = setup(lab(OLD_ADMIN()));
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
    const before = structuredClone([...roles.entries()]); const w = writes.length; const a = access.mock.calls.length;
    const r2 = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
    expect(writes.length).toBe(w); expect(access.mock.calls.length).toBe(a); expect([...roles.entries()]).toEqual(before);
    expect((r2.body as any).add_missing).toEqual([{ role_code: 'corp_admin', missing: [], extra: [EXTRA], added: [] }]);
    expect(r2.body).toMatchObject({ updated: [], unchanged: ['corp_admin'] });
  });

  it('repeatable: two roles, only the one that lacks permissions is written and audited (once)', async () => {
    const ACC = pr(CORP, 'corp_accounts');
    const { svc, ctx, access, writes } = setup(lab(OLD_ADMIN(), row({ id: idN(0x403), code: 'corp_accounts', mfa_required: ACC.mfa_required, permission_codes: sorted(ACC.permissions) })));
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin', 'corp_accounts'], true));
    expect(writes.map((w) => w.arg.roleId)).toEqual([idN(0x401)]); expect(access).toHaveBeenCalledTimes(1);
    expect((r.body as any).add_missing.map((x: any) => x.role_code)).toEqual(['corp_admin', 'corp_accounts']);
    expect(r.body).toMatchObject({ updated: ['corp_admin'] });
  });

  it('never touches a role that is not named, creates no role, never reads another tenant', async () => {
    const ACC = pr(CORP, 'corp_accounts'); const half = sorted(ACC.permissions).slice(0, 1);
    const { svc, ctx, of, writes, calls } = setup(lab(OLD_ADMIN(), row({ id: idN(0x403), code: 'corp_accounts', permission_codes: half })));
    const tenantB = structuredClone(of(TENANT_B)); const defaults = structuredClone(of(TENANT_A).filter((r) => r.is_system_default));
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
    expect(of(TENANT_A).find((x) => x.code === 'corp_accounts')!.permission_codes).toEqual(half);
    expect(writes.filter((w) => w.m === 'insertRole')).toEqual([]); expect(of(TENANT_A)).toHaveLength(DEFAULTS().length + 2);
    expect(of(TENANT_A).filter((r) => r.is_system_default)).toEqual(defaults);
    expect(calls.filter((c) => c.tenantId !== TENANT_A)).toEqual([]); expect(of(TENANT_B)).toEqual(tenantB);
  });

  it('a role with no privileged gap and mfa_required false is fine and stays mfa_required false', async () => {
    const R = CORP.roles.find((r) => !r.mfa_required && !r.permissions.some(isPriv))!; expect(R, 'no plain pack role to test with').toBeTruthy();
    const { svc, ctx, of } = setup(lab(row({ id: idN(0x404), code: R.code, mfa_required: false, permission_codes: [] })));
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES([R.code], true));
    expect(of(TENANT_A).find((x) => x.code === R.code)).toMatchObject({ mfa_required: false, permission_codes: sorted(R.permissions) });
  });

  it('an addPermissions failure propagates (caller rolls back); no success body', async () => {
    const { svc, ctx, repo } = setup(lab(OLD_ADMIN())); repo.addPermissions = async () => { throw new Error('db down'); };
    expect((await rejection(svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true)))).message).toMatch(/db down/);
  });
});

describe('ADMINPACK-3 refusals (common.validation_failed, nothing written, nothing audited)', () => {
  const refuse = async (seed: Record<string, Row[]>, input: any, third: any) => {
    const w = setup(seed); const e = await rejection(w.svc.applyRolePack(w.ctx, input, third));
    expect(e.code).toBe('common.validation_failed'); expect(w.writes).toEqual([]); expect(w.access).not.toHaveBeenCalled(); return e;
  };
  it.each([
    ['a role of the other pack', ['std_admin']], ['a default role the lab has', ['tenant_admin']], ['an unknown role', ['nope']],
    ['sql in the role code', ["corp_admin'; DROP TABLE core.roles;--"]], ['wrong case', ['CORP_ADMIN']], ['a number', [42]], ['an object', [{}]],
  ])('role %s is refused (dry run and --yes)', async (_n, roles) => {
    for (const yes of [false, true]) await refuse(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, ROLES(roles as string[], yes));
  });
  it('a pack role the lab does not have is refused (it would need creating: that is the default path, not this flag)', async () => {
    await refuse(lab(), { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
  });
  it('--yes with no role, or an empty / non-array list, is refused', async () => {
    await refuse(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, ROLES([], true));
    await refuse(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, { roles: 'corp_admin', yes: true });
    await refuse(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, { roles: undefined, yes: true });
  });
  it('all or nothing: one bad role in the list means the valid role is not written either', async () => {
    await refuse(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, ROLES(['corp_admin', 'std_admin'], true));
  });
  it('a bad packCode still fails as before', async () => { await refuse(lab(OLD_ADMIN()), { packCode: 'nope' }, ROLES(['corp_admin'], true)); });
  it('a privileged permission to a role that is not mfa_required is refused and mfa_required is NOT flipped', async () => {
    expect(ADMIN.permissions.some(isPriv)).toBe(true);
    const w = setup(lab(row({ id: idN(0x405), code: 'corp_admin', mfa_required: false, permission_codes: [] })));
    const e = await rejection(w.svc.applyRolePack(w.ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true)));
    expect(e.code).toBe('common.validation_failed'); expect(w.writes).toEqual([]); expect(w.access).not.toHaveBeenCalled();
    expect(w.of(TENANT_A).find((x) => x.code === 'corp_admin')).toMatchObject({ mfa_required: false, permission_codes: [] });
  });
  it('a permission code not in the registry (pack data bypassing the loader) is refused before any write', async () => {
    const real = structuredClone(packsFile) as any; pr(real.packs.find((p: Pack) => p.code === 'elabcorp_default'), 'corp_admin').permissions.push('zzz.not.in.registry');
    hoisted.override = real;
    try { await refuse(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true)); } finally { hoisted.override = undefined; }
  });
});

describe('ADMINPACK-3 fail closed and default behaviour unchanged', () => {
  it.each([['no tenant', { tenantId: undefined }, 'auth.unauthenticated'], ['non-uuid tenant', { tenantId: "x'; DROP TABLE core.roles;--" }, 'auth.unauthenticated'],
    ['no actor', { actor: undefined }, 'auth.unauthenticated'], ['no tx', { tx: undefined }, 'auth.unauthenticated'], ['no audit.access', { audit: undefined }, 'common.internal']])(
    '%s -> %s, no repo write', async (_n, o, code) => {
      const { svc, writes } = setup(lab(OLD_ADMIN())); const { ctx } = ctxOf(o as any);
      expect((await rejection(svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true)))).code).toBe(code); expect(writes).toEqual([]);
    });
  it('without the new argument an existing old corp_admin is still not rewritten (R6 tenant edits win)', async () => {
    const { svc, ctx, writes, of } = setup(lab(OLD_ADMIN()));
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    expect(writes.some((x) => x.m === 'addPermissions' && x.arg.roleId === idN(0x401))).toBe(false);
    expect(of(TENANT_A).find((x) => x.code === 'corp_admin')!.permission_codes).toEqual(sorted([...HAS, EXTRA]));
    expect(r.body).toMatchObject({ pack_code: 'elabcorp_default', updated: [] }); expect(r.body.unchanged).toContain('corp_admin'); expect(r.body).not.toHaveProperty('add_missing');
  });
  it('the repo gained no remove / update method and its SQL stays insert-only', async () => {
    expect(Object.keys(createRolePackRepo()).sort()).toEqual(['addPermissions', 'insertRole', 'listRoles']);
    const stmts: string[] = []; const tx = { async query(t: string) { stmts.push(t); return { rows: [] }; } };
    await createRolePackRepo().addPermissions(tx, TENANT_A, idN(1), ['identity.self.manage'], ACTOR);
    expect(stmts.join('\n')).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|DROP)\b/i); expect(stmts.join('\n')).toMatch(/ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i);
  });
  it('the service and the CLI cite LD-262 in a comment', () => {
    for (const f of [['service', 'role-pack.service.ts'], ['cli', 'apply-role-pack.ts']]) expect(readFileSync(join(IDENTITY, f[0]!, f[1]!), 'utf8'), f[1]).toMatch(/LD-262/);
  });
});

describe('ADMINPACK-3 founder runbook (.orchestra/notes/ADMINPACK-3-runbook.md)', () => {
  const RUNBOOK = join(REPO_ROOT, '.orchestra', 'notes', 'ADMINPACK-3-runbook.md');
  const md = existsSync(RUNBOOK) ? readFileSync(RUNBOOK, 'utf8') : ''; const norm = md.replace(/\s+/g, ' ');
  const BASE = 'pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid>';
  it('exists', () => { expect(existsSync(RUNBOOK), `missing ${RUNBOOK}`).toBe(true); });
  it.each([['elabcorp_default', 'corp_admin'], ['elabassist_standard', 'std_admin']])('gives the dry run, then the --yes command, for %s / %s', (pack, role) => {
    const dry = `${BASE} --pack ${pack} --add-missing ${role}`;
    expect(norm).toContain(dry); expect(norm).toContain(`${dry} --yes`);
    expect(norm.indexOf(dry)).toBeLessThan(norm.indexOf(`${dry} --yes`));
  });
  it('explains the dry-run output (would be added / only in the lab, never removed), that --yes is the second step, and that the admin signs in again', () => {
    expect(md).toMatch(/dry run/i); expect(md).toMatch(/never removed|not removed|nothing is removed|never remove/i);
    expect(md).toMatch(/added/i); expect(md).toMatch(/sign in again|sign-in again|log in again/i); expect(md).toMatch(/administrator|admin/i);
  });
  it('names the libpq variables (names only) and contains no secret value, real host or password assignment', () => {
    for (const v of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) expect(md).toContain(v);
    expect(md).not.toMatch(/PG(PASSWORD|HOST|USER|DATABASE|PORT)\s*=\s*[^\s<`'"]/); expect(md).not.toMatch(/postgres(ql)?:\/\/\S+@/i);
    expect(md).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/); expect(md).not.toMatch(/-----BEGIN|AKIA[0-9A-Z]{12}|sk-[A-Za-z0-9]{16}/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ADMINPACK-4 (LD-265, LD-189): every refusal carries ONE fixed reason from a closed set, so the CLI can say WHY. Refusal stays LimsError
// 'common.validation_failed' (message = code only). ASSUMED API: the thrown error gets two own properties
//   reason: 'args' | 'role_not_in_pack' | 'role_missing_in_lab' | 'role_is_system_default' | 'unassignable_code' | 'privileged_without_mfa'
//   role_code?: string   (the pack role the refusal concerns; absent for 'args'; never a permission code, never data from the lab)
// Check order per role: not in pack -> missing in lab -> system default -> unassignable code -> privileged without mfa. Nothing else about the service changes.
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('ADMINPACK-4 refusal reason codes', () => {
  const REASONS = ['args', 'role_not_in_pack', 'role_missing_in_lab', 'role_is_system_default', 'unassignable_code', 'privileged_without_mfa'];
  const why = async (seed: Record<string, Row[]>, input: any, third: any) => {
    const w = setup(seed); const e = await rejection(w.svc.applyRolePack(w.ctx, input, third));
    expect(e.code).toBe('common.validation_failed'); expect(e.message).toBe('common.validation_failed');
    expect(REASONS).toContain(e.reason); expect(w.writes).toEqual([]); expect(w.access).not.toHaveBeenCalled();
    return e as { reason: string; role_code?: string };
  };

  it('role_not_in_pack: a role of the other pack, a default role name, an unknown role -> reason + the role code', async () => {
    for (const rc of ['std_admin', 'tenant_admin', 'nope']) {
      const e = await why(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, ROLES([rc], true));
      expect(e.reason).toBe('role_not_in_pack'); expect(e.role_code).toBe(rc);
    }
  });
  it('role_missing_in_lab: the pack has the role, the lab does not -> reason + role code', async () => {
    const e = await why(lab(), { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], false));
    expect(e.reason).toBe('role_missing_in_lab'); expect(e.role_code).toBe('corp_admin');
  });
  it('role_is_system_default: the lab role with the pack code is a system default role -> reason + role code', async () => {
    const e = await why(lab(row({ id: idN(0x410), code: 'corp_admin', is_system_default: true, mfa_required: true })), { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
    expect(e.reason).toBe('role_is_system_default'); expect(e.role_code).toBe('corp_admin');
  });
  it('unassignable_code: a pack permission not in contracts/permissions.yaml -> reason + role code, the code itself is not echoed', async () => {
    const real = structuredClone(packsFile) as any; pr(real.packs.find((p: Pack) => p.code === 'elabcorp_default'), 'corp_admin').permissions.push('zzz.not.in.registry');
    hoisted.override = real;
    try {
      const e = await why(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
      expect(e.reason).toBe('unassignable_code'); expect(e.role_code).toBe('corp_admin');
      expect(JSON.stringify(e)).not.toContain('zzz.not.in.registry');
    } finally { hoisted.override = undefined; }
  });
  it('privileged_without_mfa: a privileged code to add, the lab role is not mfa_required -> reason + role code', async () => {
    const e = await why(lab(row({ id: idN(0x411), code: 'corp_admin', mfa_required: false, permission_codes: [] })), { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true));
    expect(e.reason).toBe('privileged_without_mfa'); expect(e.role_code).toBe('corp_admin');
  });
  it('args: empty / non-array / duplicate role list, yes not a boolean, non-string role code, bad pack code -> reason args, no role code', async () => {
    const L = lab(OLD_ADMIN());
    const cases: Array<[any, any]> = [
      [{ packCode: 'elabcorp_default' }, ROLES([], true)], [{ packCode: 'elabcorp_default' }, { roles: 'corp_admin', yes: true }],
      [{ packCode: 'elabcorp_default' }, ROLES(['corp_admin', 'corp_admin'], true)], [{ packCode: 'elabcorp_default' }, { roles: ['corp_admin'], yes: 'true' }],
      [{ packCode: 'elabcorp_default' }, ROLES([42 as any], true)], [{ packCode: 'nope' }, ROLES(['corp_admin'], true)], [{ packCode: 7 }, ROLES(['corp_admin'], true)],
    ];
    for (const [input, third] of cases) { const e = await why(L, input, third); expect(e.reason).toBe('args'); expect(e.role_code).toBeUndefined(); }
  });
  it('plain apply (no add-missing) with a bad pack code is also reason args', async () => {
    const w = setup(lab(OLD_ADMIN())); const e = await rejection(w.svc.applyRolePack(w.ctx, { packCode: 'nope' }));
    expect(e.code).toBe('common.validation_failed'); expect(e.reason).toBe('args'); expect(w.writes).toEqual([]);
  });
  it('a multi-role request reports the FIRST refused role in the order given, and still writes nothing', async () => {
    const e = await why(lab(OLD_ADMIN()), { packCode: 'elabcorp_default' }, ROLES(['corp_admin', 'nope', 'corp_accounts'], true));
    expect(e.reason).toBe('role_not_in_pack'); expect(e.role_code).toBe('nope');
  });
  it('fail-closed errors carry no reason (auth.unauthenticated, common.internal)', async () => {
    const { svc } = setup(lab(OLD_ADMIN()));
    const a = await rejection(svc.applyRolePack(ctxOf({ tx: undefined }).ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true)));
    const b = await rejection(svc.applyRolePack(ctxOf({ audit: undefined }).ctx, { packCode: 'elabcorp_default' }, ROLES(['corp_admin'], true)));
    expect([a.code, a.reason, b.code, b.reason]).toEqual(['auth.unauthenticated', undefined, 'common.internal', undefined]);
  });
  it('the plain apply body already lists role codes under created / updated / unchanged and stays unchanged', async () => {
    const w = setup(lab(OLD_ADMIN()));
    const r = await w.svc.applyRolePack(w.ctx, { packCode: 'elabcorp_default' });
    expect(r.body.created).toEqual(CORP.roles.map((x) => x.code).filter((c) => c !== 'corp_admin')); expect(r.body.unchanged).toEqual(['corp_admin']); expect(r.body.updated).toEqual([]);
  });
  it('the service cites LD-265 in a comment', () => { expect(readFileSync(join(IDENTITY, 'service', 'role-pack.service.ts'), 'utf8')).toMatch(/LD-265/); });
});
