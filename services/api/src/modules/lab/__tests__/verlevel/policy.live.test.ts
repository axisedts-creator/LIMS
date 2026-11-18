// T0B-VERLEVEL-1 (LD-316) done_when (2) POLICY: resolution test > department > lab (default level 2 + pathologist), the number required is FROZEN on the result when its first sign-off is recorded,
// upsertVerificationPolicy validates level 1..3 and that the department / test exists in the tenant, listVerificationPolicies, permissions (lab.verification_policy.read / .manage, manage is privileged = aal2).
// Tenant A: case scoped policies only (own test / department per case, parallel files never meet). Tenant B: the lab scope policy is mutated and restored in ONE file (this one) - never in A.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T, TENANT_A, TENANT_B, asOwner, closePools, fire, live, owner, req, requireDb, uid } from '../probes/kit.js';
import { PORTS, addResult, code, dto, http, newCase, person, policyFor, rowOf, seedCatalog, setPolicy, verify, approve, why, type Case } from './helpers.js';

afterAll(async () => { await closePools(); });
describe('harness', () => { it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); }); });

const mgr = () => person('manager');
const put = (who: ReturnType<typeof person>, body: unknown, ifMatch?: number) =>
  fire('upsertVerificationPolicy', req({ headers: { 'idempotency-key': uid(), ...(ifMatch === undefined ? {} : { 'if-match': `"${ifMatch}"` }) }, body }), who, { ports: PORTS });
const list = (who: ReturnType<typeof person>) => fire('listVerificationPolicies', req(), who, { ports: PORTS });
const activeRows = (where: string, v: unknown[]) => owner(`SELECT id, scope, required_verifiers, require_pathologist, allow_enterer_verify, active, version FROM lab.verification_policy WHERE active AND ${where}`, v);

describe.skipIf(!live)('listVerificationPolicies + permissions', () => {
  it('lists the active policies of the tenant; the lab default (2, pathologist required, enterer not allowed) is always there', { timeout: T }, async () => {
    const o = await list(person('tech'));          // lab.verification_policy.read: every lab role
    expect(o.reply?.status, why(o)).toBe(200);
    const lab = dto(o).data.filter((p: any) => p.scope === 'lab');
    expect(lab).toHaveLength(1);
    expect(lab[0]).toMatchObject({ required_verifiers: expect.any(Number), active: true });
    expect(Object.keys(lab[0]).sort()).toEqual(expect.arrayContaining(['id', 'scope', 'required_verifiers', 'require_pathologist', 'allow_enterer_verify', 'active', 'version', 'updated_at']));
    for (const p of dto(o).data) expect(p.active, 'only active policies are listed').toBe(true);
  });
  it('the seeded lab default of tenant A is level 2, pathologist required, enterer not allowed (reproduces today)', { timeout: T }, async () => {
    const rows = await activeRows("tenant_id = $1 AND scope = 'lab'", [TENANT_A]);
    expect(rows.map((r) => [r.required_verifiers, r.require_pathologist, r.allow_enterer_verify])).toEqual([[2, true, false]]);
  });
  it('upsert is privileged: lab.verification_policy.manage needs aal2 (auth.mfa_required), and a technologist without the permission gets auth.forbidden', { timeout: T }, async () => {
    const body = { scope: 'lab', required_verifiers: 2 };
    expect(code(await put(person('manager', 'a', { mfa: 'aal1' }), body))).toBe('auth.mfa_required');
    expect(code(await put(person('tech'), body))).toBe('auth.forbidden');
    expect(code(await put(person('patho'), body)), 'the pathologist role does not manage the policy').toBe('auth.forbidden');
  });
  it('a front desk person cannot read the policies (auth.forbidden)', { timeout: T }, async () => {
    expect(code(await list(person('tech', 'a', { grants: [] })))).toBe('auth.forbidden');
  });
});

describe.skipIf(!live)('upsertVerificationPolicy: validation, create, update, deactivate', () => {
  let k: Case;
  beforeAll(async () => { if (!live) return; k = await newCase(); await seedCatalog(TENANT_A, { departmentId: k.departmentId, testId: k.testId }); }, T * 2);

  it.each([
    ['level 0', { scope: 'lab', required_verifiers: 0 }], ['level 4', { scope: 'lab', required_verifiers: 4 }], ['level 2.5', { scope: 'lab', required_verifiers: 2.5 }],
    ['level as text', { scope: 'lab', required_verifiers: '2' }], ['level missing', { scope: 'lab' }], ['unknown scope', { scope: 'branch', required_verifiers: 2 }],
    ['lab scope with a test id', { scope: 'lab', required_verifiers: 2, test_id: uid() }], ['lab scope with a department id', { scope: 'lab', required_verifiers: 2, department_id: uid() }],
    ['test scope without a test id', { scope: 'test', required_verifiers: 2 }], ['department scope without a department id', { scope: 'department', required_verifiers: 2 }],
    ['test scope with a department id', { scope: 'test', required_verifiers: 2, department_id: uid() }], ['both ids', { scope: 'test', required_verifiers: 2, test_id: uid(), department_id: uid() }],
    ['flag not a boolean', { scope: 'lab', required_verifiers: 2, require_pathologist: 'yes' }],
  ])('rejects %s with 400 common.validation_failed and writes nothing', { timeout: T }, async (_n, body) => {
    const before = Number((await owner('SELECT count(*)::int AS n FROM lab.verification_policy WHERE tenant_id = $1', [TENANT_A]))[0].n);
    const o = await put(mgr(), body);
    expect([code(o), http(o)], why(o)).toEqual(['common.validation_failed', 400]);
    expect(Number((await owner('SELECT count(*)::int AS n FROM lab.verification_policy WHERE tenant_id = $1', [TENANT_A]))[0].n)).toBeGreaterThanOrEqual(before);   // parallel files only add
    expect(await activeRows("tenant_id = $1 AND scope = 'lab'", [TENANT_A])).toHaveLength(1);
  });
  it('a test id that does not exist in the tenant is refused (not_found or validation_failed), no row', { timeout: T }, async () => {
    const t = uid();
    const o = await put(mgr(), { scope: 'test', test_id: t, required_verifiers: 3 });
    expect(['common.not_found', 'common.validation_failed'], why(o)).toContain(code(o));
    expect(await activeRows('test_id = $1', [t])).toHaveLength(0);
  });
  it('a department id that does not exist in the tenant is refused, no row', { timeout: T }, async () => {
    const d = uid();
    const o = await put(mgr(), { scope: 'department', department_id: d, required_verifiers: 3 });
    expect(['common.not_found', 'common.validation_failed'], why(o)).toContain(code(o));
    expect(await activeRows('department_id = $1', [d])).toHaveLength(0);
  });
  it('a test / department that exists only in the OTHER tenant is refused for this tenant (existence is checked per tenant)', { timeout: T * 2 }, async () => {
    const other = await newCase({ side: 'b' }); await seedCatalog(TENANT_B, { departmentId: other.departmentId, testId: other.testId });
    const o1 = await put(mgr(), { scope: 'test', test_id: other.testId, required_verifiers: 3 });
    const o2 = await put(mgr(), { scope: 'department', department_id: other.departmentId, required_verifiers: 3 });
    for (const o of [o1, o2]) expect(['common.not_found', 'common.validation_failed'], why(o)).toContain(code(o));
    expect(await activeRows('test_id = $1 OR department_id = $2', [other.testId, other.departmentId])).toHaveLength(0);
  });

  it('create (no If-Match) -> 200 with the policy (defaults: pathologist required true, enterer false, active true, version 1); list shows it; a second create for the same target needs If-Match (428)', { timeout: T * 2 }, async () => {
    const o = await put(mgr(), { scope: 'test', test_id: k.testId, required_verifiers: 3 });
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o)).toMatchObject({ scope: 'test', test_id: k.testId, required_verifiers: 3, require_pathologist: true, allow_enterer_verify: false, active: true, version: 1 });
    expect(Object.keys(dto(o))).not.toContain('tenant_id');
    expect(dto(await list(person('tech'))).data.map((p: any) => p.id)).toContain(dto(o).id);
    const dup = await put(mgr(), { scope: 'test', test_id: k.testId, required_verifiers: 2 });
    expect([code(dup), http(dup)], why(dup)).toEqual(['common.precondition_required', 428]);
    expect(await activeRows('test_id = $1', [k.testId])).toHaveLength(1);
  });
  it('update with the right If-Match -> version 2 (still ONE active row for the target); a stale If-Match -> common.version_conflict', { timeout: T * 2 }, async () => {
    const [row] = await activeRows('test_id = $1', [k.testId]);
    const stale = await put(mgr(), { scope: 'test', test_id: k.testId, required_verifiers: 1 }, row.version + 5);
    expect(code(stale), why(stale)).toBe('common.version_conflict');
    const o = await put(mgr(), { scope: 'test', test_id: k.testId, required_verifiers: 1, require_pathologist: false, allow_enterer_verify: true }, row.version);
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o)).toMatchObject({ required_verifiers: 1, require_pathologist: false, allow_enterer_verify: true, version: row.version + 1 });
    const rows = await activeRows('test_id = $1', [k.testId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ required_verifiers: 1, require_pathologist: false, allow_enterer_verify: true });
  });
  it('a department policy can be created for an existing department', { timeout: T * 2 }, async () => {
    const o = await put(mgr(), { scope: 'department', department_id: k.departmentId, required_verifiers: 3 });
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o)).toMatchObject({ scope: 'department', department_id: k.departmentId, required_verifiers: 3 });
  });
  it('active false deactivates (never deletes): the row stays, is no longer listed, and the result falls back to the next scope', { timeout: T * 3 }, async () => {
    const [row] = await activeRows('test_id = $1', [k.testId]);
    const o = await put(mgr(), { scope: 'test', test_id: k.testId, required_verifiers: 1, active: false }, row.version);
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o).active).toBe(false);
    expect(await activeRows('test_id = $1', [k.testId])).toHaveLength(0);
    expect(Number((await owner('SELECT count(*)::int AS n FROM lab.verification_policy WHERE test_id = $1', [k.testId]))[0].n), 'the row is kept').toBe(1);
    expect(dto(await list(person('tech'))).data.map((p: any) => p.id)).not.toContain(row.id);
    // the department policy (level 3, created above) now applies to a new result of this department/test
    const r = await addResult(k);
    expect((await verify(person('tech'), r.id)).reply?.status).toBe(200);
    expect((await rowOf(r.id)).signoff_required, 'department policy after the test policy was deactivated').toBe(3);
  });
});

describe.skipIf(!live)('resolution: test, else department, else lab; frozen when the first sign-off is recorded', () => {
  it('lab default applies when no test or department policy exists: required 2, pathologist required', { timeout: T * 3 }, async () => {
    const k = await newCase();
    const o = await verify(person('tech'), k.id);
    expect(o.reply?.status, why(o)).toBe(200);
    expect([dto(o).signoff_required, dto(o).next_step]).toEqual([2, 'approve']);
  });
  it('department policy beats the lab default; test policy beats the department policy; an INACTIVE test policy is ignored', { timeout: T * 4 }, async () => {
    const k = await newCase();
    await setPolicy(TENANT_A, { scope: 'department', departmentId: k.departmentId, level: 3, pathologist: false });
    await setPolicy(TENANT_A, { scope: 'test', testId: k.testId, level: 1, pathologist: false, active: false });   // inactive: must not win
    const dept = await verify(person('tech'), k.id);
    expect(dept.reply?.status, why(dept)).toBe(200);
    expect([dto(dept).signoff_required, dto(dept).status]).toEqual([3, 'verified']);
    const k2 = await addResult(k);                                                                                    // same test and department
    await setPolicy(TENANT_A, { scope: 'test', testId: k.testId, level: 1, pathologist: false });                     // now an active test policy
    const test = await verify(person('tech'), k2.id);
    expect(test.reply?.status, why(test)).toBe(200);
    expect([dto(test).signoff_required, dto(test).status], 'test beats department').toEqual([1, 'approved']);
  });
  it('another test of the same department does not see the test policy of this test', { timeout: T * 3 }, async () => {
    const a = await newCase(); await policyFor(a, 1, { pathologist: false });
    const b = await newCase();   // other test id, other department: lab default
    expect(dto(await verify(person('tech'), a.id)).status).toBe('approved');
    expect(dto(await verify(person('tech'), b.id)).signoff_required).toBe(2);
  });
  it('FROZEN: a policy change after the first sign-off never alters the result in progress; a result with no sign-off yet takes the new policy', { timeout: T * 4 }, async () => {
    const k = await newCase(); const idle = await addResult(k);
    const pid = await policyFor(k, 2);
    expect((await verify(person('tech'), k.id)).reply?.status).toBe(200);
    expect((await rowOf(k.id)).signoff_required).toBe(2);
    await asOwner(TENANT_A, (c) => c.query('UPDATE lab.verification_policy SET required_verifiers = 3 WHERE id = $1', [pid]));   // the lab changes the level to 3 in the middle
    const fin = await approve(person('patho'), k.id);
    expect(fin.reply?.status, `still final after 2 sign-offs: ${why(fin)}`).toBe(200);
    expect([dto(fin).status, dto(fin).signoff_required, dto(fin).signoff_count]).toEqual(['approved', 2, 2]);
    const o = await verify(person('tech'), idle.id);                                                                  // no sign-off yet: takes level 3
    expect([dto(o).signoff_required, dto(o).next_step, dto(o).status]).toEqual([3, 'verify', 'verified']);
    await asOwner(TENANT_A, (c) => c.query('UPDATE lab.verification_policy SET required_verifiers = 1, require_pathologist = false WHERE id = $1', [pid]));
    const o2 = await verify(person('tech'), idle.id);
    expect([dto(o2).signoff_required, dto(o2).status, dto(o2).signoff_count], 'level 3 stays 3 after a change to 1').toEqual([3, 'verified', 2]);
  });
  it('tenant isolation of policy: a test policy of tenant B for the same test id never applies to a tenant A result', { timeout: T * 3 }, async () => {
    const k = await newCase();
    await setPolicy(TENANT_B, { scope: 'test', testId: k.testId, level: 1, pathologist: false });
    const o = await verify(person('tech'), k.id);
    expect(o.reply?.status, why(o)).toBe(200);
    expect([dto(o).signoff_required, dto(o).status], 'tenant A applies its own lab default').toEqual([2, 'verified']);
  });
});

describe.skipIf(!live)('the lab scope policy (tenant B only; restored)', () => {
  let original: { id: string; version: number; required_verifiers: number; require_pathologist: boolean; allow_enterer_verify: boolean } | undefined;
  beforeAll(async () => { if (!live) return; original = (await activeRows("tenant_id = $1 AND scope = 'lab'", [TENANT_B]))[0] as typeof original; }, T);
  afterAll(async () => {
    if (!live || !original) return;
    const o = original;
    await asOwner(TENANT_B, async (c) => {
      await c.query('UPDATE lab.verification_policy SET active = false WHERE tenant_id = $1 AND scope = $2 AND id <> $3', [TENANT_B, 'lab', o.id]);
      await c.query('UPDATE lab.verification_policy SET active = true, required_verifiers = $2, require_pathologist = $3, allow_enterer_verify = $4 WHERE id = $1', [o.id, o.required_verifiers, o.require_pathologist, o.allow_enterer_verify]);
    });
  });

  it('tenant B has its own lab default (2 / pathologist / enterer no)', () => {
    expect([original?.required_verifiers, original?.require_pathologist, original?.allow_enterer_verify]).toEqual([2, true, false]);
  });
  it('changing the lab policy through the API applies to results whose sign-off has not started: level 1 without pathologist -> one technologist verify is final', { timeout: T * 4 }, async () => {
    const m = person('manager', 'b');
    const o = await put(m, { scope: 'lab', required_verifiers: 1, require_pathologist: false }, original!.version);
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o)).toMatchObject({ scope: 'lab', required_verifiers: 1, require_pathologist: false, active: true });
    expect(await activeRows("tenant_id = $1 AND scope = 'lab'", [TENANT_B])).toHaveLength(1);
    const k = await newCase({ side: 'b' });
    const v = await verify(person('tech', 'b'), k.id);
    expect(v.reply?.status, why(v)).toBe(200);
    expect([dto(v).status, dto(v).signoff_required, dto(v).next_step]).toEqual(['approved', 1, 'none']);
  });
  it('the lab scope policy cannot be deactivated (it stays active; the call is refused)', { timeout: T * 3 }, async () => {
    const m = person('manager', 'b');
    const [cur] = await activeRows("tenant_id = $1 AND scope = 'lab'", [TENANT_B]);
    const o = await put(m, { scope: 'lab', required_verifiers: 2, active: false }, cur.version);
    expect(o.reply, 'refused').toBeUndefined();
    expect(http(o)).toBeGreaterThanOrEqual(400);
    expect(http(o)).toBeLessThan(500);
    expect(await activeRows("tenant_id = $1 AND scope = 'lab'", [TENANT_B])).toHaveLength(1);
  });
  it('A and B stay apart: the B lab policy change did not touch tenant A (list shows no B policy id)', { timeout: T * 2 }, async () => {
    const a = dto(await list(person('tech'))).data.map((p: any) => p.id);
    const b = dto(await list(person('tech', 'b'))).data.map((p: any) => p.id);
    expect(a.filter((x: string) => b.includes(x))).toEqual([]);
  });
});
