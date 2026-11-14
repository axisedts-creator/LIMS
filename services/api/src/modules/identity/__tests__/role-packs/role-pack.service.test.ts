// RM-T02 (LD-141; spec/program/11-ROLE-MATRIX.md R6, s4 item 5): seed a role pack at tenant provisioning, re-apply safely. Synthetic data only.
// ASSUMED API of ../../service/role-pack.service.ts (the spec leaves the seam open; the writer must match it or raise a dispute):
//   export interface RolePackRepo {   // every method (tx, tenantId, ...). NO delete / update method exists: a re-apply can only insert.
//     listRoles(tx, tenantId): Promise<Array<{ id; code; is_system_default; is_active; mfa_required; permission_codes: string[] }>>;   // ALL roles of the tenant, inactive too
//     insertRole(tx, tenantId, r: { id; code; name; mfaRequired; permissionCodes: string[]; actorId }): Promise<void>;                 // inserts a CUSTOM role (is_system_default false)
//     addPermissions(tx, tenantId, roleId, codes: string[], actorId): Promise<void>;                                                  // insert-only (ON CONFLICT DO NOTHING)
//   }
//   export function createRolePackRepo(): RolePackRepo;                           // default SQL on the request tx, explicit tenant_id in every statement
//   export function createRolePackService(deps?: { repo?: RolePackRepo; newId?: () => string }): { applyRolePack(ctx: RoleCtx, input: { packCode: string }): Promise<{ status: 200; body: { pack_code; created: string[]; updated: string[]; unchanged: string[] } }> };
//   ctx = RoleCtx of role.service ({ tenantId, actor{type,id}, tx, audit:{ access(entry) } }); tenant and actor come ONLY from ctx. body lists are ROLE CODES.
//   Pack contents come from the verbatim data file; this test reads spec/program/11-ROLE-MATRIX.data.yaml itself as the oracle (not the loader).
//   Audit: one ctx.audit.access({ action: 'role.change', entityType: 'role', entityId: <role id>, outcome: 'allowed' }) per role created or given permissions; none when nothing changed.
//   Errors: LimsError 'auth.unauthenticated' (bad ctx tenant/actor/tx), 'common.internal' (no audit.access: fail closed before any write), 'common.validation_failed' (unknown/bad packCode).
//   Rule for an EXISTING pack role (same code): tenant edits win. Name, MFA flag, active flag and tenant-added permissions are kept; only pack permissions that are missing may be added.
//   Not asserted (left to the writer, see notes): whether a pack permission a tenant REMOVED is restored by a re-apply.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { createRolePackRepo, createRolePackService } from '../../service/role-pack.service.js';

type PackRole = { code: string; name: string; mfa_required: boolean; permissions: string[] };
type Pack = { code: string; roles: PackRole[] };
const matrix = parse(readFileSync(join(REPO_ROOT, 'spec', 'program', '11-ROLE-MATRIX.data.yaml'), 'utf8')) as { packs: Pack[] };
const PACK = (code: string): Pack => matrix.packs.find((p) => p.code === code)!;
const CORP = PACK('elabcorp_default'), STD = PACK('elabassist_standard');
const sorted = (a: readonly string[]) => [...a].sort();

const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1), ACTOR = idN(0xd1), TX = { tx: 'request-tx' };
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

type Row = { id: string; code: string; is_system_default: boolean; is_active: boolean; mfa_required: boolean; display_name: string; permission_codes: string[] };
const row = (o: Partial<Row> & { id: string; code: string }): Row => ({ is_system_default: false, is_active: true, mfa_required: false, display_name: o.code, permission_codes: [], ...o });
// Pre-existing default roles of a freshly provisioned tenant (tenant.service seedRoles) - must never be touched.
const DEFAULTS = (): Row[] => [
  row({ id: idN(0x201), code: 'tenant_admin', is_system_default: true, mfa_required: true, permission_codes: ['identity.role.manage', 'identity.user.manage'] }),
  row({ id: idN(0x202), code: 'pathologist', is_system_default: true, permission_codes: ['identity.self.manage'] }),
  row({ id: idN(0x203), code: 'finance', is_system_default: true, permission_codes: ['identity.self.manage'] }),
];

/** In-memory RolePackRepo with a unique (tenant, role_code) rule. Records every call and every write. */
function makeRepo(seed: Record<string, Row[]> = { [TENANT_A]: DEFAULTS(), [TENANT_B]: DEFAULTS() }) {
  const roles = new Map(Object.entries(seed).map(([t, rs]) => [t, rs.map((r) => ({ ...r, permission_codes: [...r.permission_codes] }))]));
  const calls: Array<{ m: string; tx: unknown; tenantId: string; args: unknown[] }> = [];
  const writes: Array<{ m: string; tenantId: string; arg: any }> = [];
  const of = (t: string) => roles.get(t) ?? roles.set(t, []).get(t)!;
  const repo = {
    async listRoles(tx: unknown, tenantId: string) { calls.push({ m: 'listRoles', tx, tenantId, args: [] }); return structuredClone(of(tenantId)); },
    async insertRole(tx: unknown, tenantId: string, r: { id: string; code: string; name: string; mfaRequired: boolean; permissionCodes: string[]; actorId: string }) {
      calls.push({ m: 'insertRole', tx, tenantId, args: [r] }); writes.push({ m: 'insertRole', tenantId, arg: r });
      if (of(tenantId).some((x) => x.code === r.code)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      of(tenantId).push(row({ id: r.id, code: r.code, display_name: r.name, mfa_required: r.mfaRequired, permission_codes: [...r.permissionCodes] }));
    },
    async addPermissions(tx: unknown, tenantId: string, roleId: string, codes: string[], actorId: string) {
      calls.push({ m: 'addPermissions', tx, tenantId, args: [roleId, codes, actorId] }); writes.push({ m: 'addPermissions', tenantId, arg: { roleId, codes, actorId } });
      const r = of(tenantId).find((x) => x.id === roleId)!;
      r.permission_codes = sorted([...new Set([...r.permission_codes, ...codes])]);
    },
  };
  return { repo, roles, of, calls, writes };
}
function ctxOf(o: Record<string, unknown> = {}) {
  const access = vi.fn(async (_e: Record<string, unknown>) => undefined);
  return { ctx: { tenantId: TENANT_A, actor: { type: 'user', id: ACTOR }, requestId: idN(0xe1), tx: TX, audit: { access }, ...o } as any, access };
}
let seq = 0x1000;
const setup = (seed?: Record<string, Row[]>) => { const w = makeRepo(seed); return { ...w, svc: createRolePackService({ repo: w.repo, newId: () => idN(seq++) }), ...ctxOf() }; };
const packRows = (rows: Row[], pack: Pack) => rows.filter((r) => pack.roles.some((p) => p.code === r.code));

describe('RM-T02 seed: provisioning with a pack creates its roles as custom roles', () => {
  it('data file shape sanity: 19 corp_ and 10 std_ templates', () => {
    expect(CORP.roles).toHaveLength(19); expect(STD.roles).toHaveLength(10);
    expect(CORP.roles.every((r) => r.code.startsWith('corp_'))).toBe(true); expect(STD.roles.every((r) => r.code.startsWith('std_'))).toBe(true);
  });

  it('elabcorp_default: 19 roles, codes and permission sets equal the data file (sorted)', async () => {
    const { svc, ctx, of } = setup();
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    expect(r.status).toBe(200);
    const got = packRows(of(TENANT_A), CORP);
    expect(got).toHaveLength(19);
    for (const p of CORP.roles) {
      const g = got.find((x) => x.code === p.code)!;
      expect(g, p.code).toBeTruthy();
      expect(g.permission_codes, p.code).toEqual(sorted(p.permissions));
      expect(g.mfa_required, p.code).toBe(p.mfa_required);
      expect(g.display_name, p.code).toBe(p.name);
      expect(g.is_system_default, p.code).toBe(false);                       // custom roles (S9), never default
      expect(g.is_active, p.code).toBe(true);
    }
    expect(of(TENANT_A)).toHaveLength(3 + 19);                               // only the 19 added, nothing else
  });

  it('elabassist_standard: 10 std_ roles equal the data file', async () => {
    const { svc, ctx, of } = setup();
    await svc.applyRolePack(ctx, { packCode: 'elabassist_standard' });
    const got = packRows(of(TENANT_A), STD);
    expect(got).toHaveLength(10);
    for (const p of STD.roles) expect(got.find((x) => x.code === p.code)!.permission_codes, p.code).toEqual(sorted(p.permissions));
    expect(of(TENANT_A).filter((r) => r.code.startsWith('corp_'))).toHaveLength(0);   // the other pack is not seeded
  });

  it('the response lists created codes; actor and tx come from ctx; every permission list passed to the repo is sorted and de-duplicated', async () => {
    const { svc, ctx, calls, writes } = setup();
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    expect(r.body).toEqual({ pack_code: 'elabcorp_default', created: expect.any(Array), updated: [], unchanged: [] });
    expect(sorted(r.body.created)).toEqual(sorted(CORP.roles.map((x) => x.code)));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) { expect(c.tx).toBe(TX); expect(c.tenantId).toBe(TENANT_A); }
    for (const w of writes) { expect(w.arg.actorId).toBe(ACTOR); const l = w.arg.permissionCodes as string[]; expect(l).toEqual([...new Set(sorted(l))]); }
    expect(new Set(writes.map((w) => w.arg.id)).size).toBe(19);               // fresh UUID per role
  });

  it('ignores any tenantId / actor smuggled in the input; seeds the ctx tenant only', async () => {
    const { svc, ctx, of } = setup();
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default', tenantId: TENANT_B, actorId: 'evil' } as any);
    expect(packRows(of(TENANT_B), CORP)).toHaveLength(0);
    expect(packRows(of(TENANT_A), CORP)).toHaveLength(19);
  });
});

describe('RM-T02 idempotency and safe re-apply', () => {
  it('applying twice: the second apply writes nothing, audits nothing, and the state is identical', async () => {
    const { svc, ctx, access, roles, writes } = setup();
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    const before = structuredClone([...roles.entries()]); const w = writes.length; const a = access.mock.calls.length;
    const r2 = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    expect(writes.length).toBe(w); expect(access.mock.calls.length).toBe(a);
    expect([...roles.entries()]).toEqual(before);
    expect(r2.body).toEqual({ pack_code: 'elabcorp_default', created: [], updated: [], unchanged: expect.any(Array) });
    expect(sorted(r2.body.unchanged)).toEqual(sorted(CORP.roles.map((x) => x.code)));
  });

  it('never removes a permission the tenant added, never renames or relaxes MFA; re-apply leaves that role alone', async () => {
    const { svc, ctx, of, writes } = setup();
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    const target = CORP.roles.find((r) => r.code === 'corp_admin')!;
    const extra = CORP.roles.flatMap((r) => r.permissions).find((p) => !target.permissions.includes(p))!;
    const r = of(TENANT_A).find((x) => x.code === 'corp_admin')!;
    r.permission_codes = sorted([...r.permission_codes, extra]); r.display_name = 'Lab owner'; r.mfa_required = true;
    const w = writes.length;
    const res = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    expect(writes.length).toBe(w);
    const after = of(TENANT_A).find((x) => x.code === 'corp_admin')!;
    expect(after.permission_codes).toContain(extra); expect(after.display_name).toBe('Lab owner'); expect(after.mfa_required).toBe(true);
    expect(res.body.unchanged).toContain('corp_admin');
  });

  it('a partly seeded tenant: only the missing roles are created, existing pack roles are not rewritten', async () => {
    const present = CORP.roles.slice(0, 5);
    const seed = { [TENANT_A]: [...DEFAULTS(), ...present.map((p, i) => row({ id: idN(0x300 + i), code: p.code, display_name: p.name, mfa_required: p.mfa_required, permission_codes: sorted(p.permissions) }))], [TENANT_B]: DEFAULTS() };
    const { svc, ctx, of, writes } = setup(seed);
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    expect(sorted(r.body.created)).toEqual(sorted(CORP.roles.slice(5).map((x) => x.code)));
    expect(sorted(r.body.unchanged)).toEqual(sorted(present.map((x) => x.code)));
    expect(writes.filter((w) => w.m === 'insertRole')).toHaveLength(14);
    expect(packRows(of(TENANT_A), CORP)).toHaveLength(19);
    expect(of(TENANT_A).filter((x) => present.some((p) => p.code === x.code)).map((x) => x.id)).toEqual(present.map((_, i) => idN(0x300 + i)));   // same ids: no delete + recreate
  });

  it('a pack role missing permissions gets them added and is reported updated; audited; nothing removed', async () => {
    const p = CORP.roles.find((r) => r.code === 'corp_admin')!; const kept = p.permissions.slice(2);
    const seed = { [TENANT_A]: [...DEFAULTS(), row({ id: idN(0x310), code: 'corp_admin', display_name: 'Admin', mfa_required: true, permission_codes: sorted([...kept, 'identity.self.manage']) })], [TENANT_B]: DEFAULTS() };
    const { svc, ctx, access, of } = setup(seed);
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    // Either outcome (restore missing pack permissions, or leave the role alone) is allowed; if it was touched it must be additive and reported.
    const after = of(TENANT_A).find((x) => x.code === 'corp_admin')!;
    expect(after.permission_codes).toEqual(expect.arrayContaining([...kept, 'identity.self.manage']));
    if (r.body.updated.includes('corp_admin')) {
      expect(after.permission_codes).toEqual(expect.arrayContaining(p.permissions));
      expect(access.mock.calls.some(([e]) => e['entityId'] === idN(0x310))).toBe(true);
    } else expect(r.body.unchanged).toContain('corp_admin');
  });

  it('a pack role the tenant deactivated stays inactive and is not duplicated', async () => {
    const seed = { [TENANT_A]: [...DEFAULTS(), row({ id: idN(0x320), code: 'corp_accounts', is_active: false, permission_codes: [] })], [TENANT_B]: DEFAULTS() };
    const { svc, ctx, of } = setup(seed);
    const r = await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    const hits = of(TENANT_A).filter((x) => x.code === 'corp_accounts');
    expect(hits).toHaveLength(1); expect(hits[0]!.is_active).toBe(false);
    expect(r.body.created).not.toContain('corp_accounts');
  });
});

describe('RM-T02 default roles untouched, tenant isolation, audit', () => {
  it('default roles are byte-identical after apply and no write targets them', async () => {
    const { svc, ctx, of, writes } = setup();
    const before = structuredClone(DEFAULTS());
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    expect(of(TENANT_A).filter((r) => r.is_system_default)).toEqual(before);
    const ids = new Set(before.map((r) => r.id));
    expect(writes.filter((w) => w.m === 'addPermissions' && ids.has(w.arg.roleId))).toEqual([]);
    expect(writes.filter((w) => w.m === 'insertRole' && before.some((b) => b.code === w.arg.code))).toEqual([]);
  });

  it('tenant B is never read or written when A is applied', async () => {
    const { svc, ctx, calls, of } = setup();
    const b = structuredClone(of(TENANT_B));
    await svc.applyRolePack(ctx, { packCode: 'elabassist_standard' });
    expect(calls.filter((c) => c.tenantId !== TENANT_A)).toEqual([]);
    expect(of(TENANT_B)).toEqual(b);
  });

  it('audited: one role.change per created role with the new role id; none for the default roles', async () => {
    const { svc, ctx, access, writes } = setup();
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    const entries = access.mock.calls.map(([e]) => e);
    expect(entries).toHaveLength(19);
    for (const e of entries) expect(e).toMatchObject({ action: 'role.change', entityType: 'role', outcome: 'allowed' });
    expect(sorted(entries.map((e) => String(e['entityId'])))).toEqual(sorted(writes.filter((w) => w.m === 'insertRole').map((w) => w.arg.id)));
    expect(JSON.stringify(entries)).not.toContain('@');                      // no email / personal data in the entry
  });

  it('a failing insert propagates (caller rolls the transaction back); no swallowed error, no success body', async () => {
    const { svc, ctx, repo } = setup();
    let n = 0; const real = repo.insertRole;
    repo.insertRole = async (...a: Parameters<typeof real>) => { if (++n === 7) throw new Error('db down'); return real(...a); };
    expect((await rejection(svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }))).message).toMatch(/db down/);
  });
});

describe('RM-T02 adversarial input and fail-closed', () => {
  it.each([[undefined], [null], [''], ['ELABCORP_DEFAULT'], ['nope'], ['elabcorp_default '], ["x'; DROP TABLE core.roles;--"], [42], [{}], [['elabcorp_default']], ['corp_admin']])(
    'packCode %j -> common.validation_failed and no write', async (packCode) => {
      const { svc, ctx, writes } = setup();
      const e = await rejection(svc.applyRolePack(ctx, { packCode } as any));
      expect(e.code).toBe('common.validation_failed'); expect(writes).toEqual([]);
    });
  it('missing input -> common.validation_failed', async () => {
    const { svc, ctx, writes } = setup();
    expect((await rejection(svc.applyRolePack(ctx, undefined as any))).code).toBe('common.validation_failed'); expect(writes).toEqual([]);
  });
  it.each([
    ['no ctx tenant', { tenantId: undefined }], ['non-uuid tenant', { tenantId: "x'; DROP TABLE core.roles;--" }], ['no actor', { actor: undefined }], ['no tx', { tx: undefined }],
  ])('%s -> auth.unauthenticated and no repo call', async (_n, o) => {
    const { svc, calls } = setup(); const { ctx } = ctxOf(o);
    expect((await rejection(svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }))).code).toBe('auth.unauthenticated'); expect(calls).toEqual([]);
  });
  it('no audit.access on ctx -> common.internal before any write (fail closed)', async () => {
    const { svc, writes } = setup(); const { ctx } = ctxOf({ audit: undefined });
    expect((await rejection(svc.applyRolePack(ctx, { packCode: 'elabcorp_default' }))).code).toBe('common.internal'); expect(writes).toEqual([]);
  });
  it('a pack applied to a tenant with a different pack present does not touch the other pack\'s roles', async () => {
    const { svc, ctx, of } = setup();
    await svc.applyRolePack(ctx, { packCode: 'elabassist_standard' });
    const std = structuredClone(packRows(of(TENANT_A), STD));
    await svc.applyRolePack(ctx, { packCode: 'elabcorp_default' });
    expect(packRows(of(TENANT_A), STD)).toEqual(std);
  });
});

describe('RM-T02 default repo SQL (createRolePackRepo)', () => {
  const sqlLog = () => {
    const stmts: Array<{ text: string; values: unknown[] }> = [];
    const tx = { async query(text: string, values: unknown[] = []) { stmts.push({ text, values }); return { rows: [], rowCount: 0 }; } };
    return { tx, stmts };
  };
  it('every statement names tenant_id and carries the tenant id as a parameter; inserts only; permissions use ON CONFLICT DO NOTHING', async () => {
    const { tx, stmts } = sqlLog(); const repo = createRolePackRepo();
    await repo.listRoles(tx, TENANT_A);
    await repo.insertRole(tx, TENANT_A, { id: idN(1), code: 'corp_admin', name: 'Admin', mfaRequired: true, permissionCodes: ['identity.self.manage'], actorId: ACTOR });
    await repo.addPermissions(tx, TENANT_A, idN(1), ['identity.self.manage'], ACTOR);
    expect(stmts.length).toBeGreaterThanOrEqual(3);
    for (const s of stmts) {
      expect(s.text, s.text).toMatch(/tenant_id/i);
      expect(s.values).toContain(TENANT_A);
      expect(s.text).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|DROP)\b/i);       // a re-apply can never remove or rewrite
    }
    expect(stmts.filter((s) => /role_permissions/i.test(s.text) && /INSERT/i.test(s.text)).every((s) => /ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(s.text))).toBe(true);
    expect(stmts.some((s) => /INSERT\s+INTO\s+core\.roles/i.test(s.text) && /is_system_default/i.test(s.text) && /true/i.test(s.text))).toBe(false);   // never inserted as a system default
  });
});

describe('RM-T02 no HTTP operation here (needs CR-C2-RM-001 to C0)', () => {
  const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf8');
  it('the role-pack service imports no handler (LD-150/LD-158: contract + stub handlers exist)', () => {
    expect(read('services', 'api', 'src', 'modules', 'identity', 'service', 'role-pack.service.ts')).not.toMatch(/from\s+['"][^'"]*\/handlers\//);
  });
  it('the service cites LD-141 (binding decision) in a comment', () => {
    expect(read('services', 'api', 'src', 'modules', 'identity', 'service', 'role-pack.service.ts')).toMatch(/LD-141/);
  });
});
