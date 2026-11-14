// C9 T-07 — the REAL repo (createPlanRepo) driven with a recording tx (no database): every statement is tenant-scoped and parameterised (REQ-SEC-022/024/082), qc_plan_versions is
// INSERT-only (05-SCHEMA §4/§5, S-06), plan updates are version-checked. RLS itself (tenants A/B on the real DDL) is proven by db/tests once C0 merges the quality DDL.
import { describe, expect, it } from 'vitest';
import { createPlanRepo } from '../repository/plan.repo.js';
import { ANA, INS, LVL, PLN, TENANT_A, TST, USER } from './plan.helpers.js';

const rec = () => {
  const q: Array<{ text: string; values: unknown[] }> = [];
  return { q, tx: { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows: [], rowCount: 0 }; } } };
};
const INJ = `x'; DROP TABLE quality.qc_plans; --`;
const plan = { id: PLN(1), instrument_id: INS(1), test_id: TST(1), analyte_id: ANA(1), status: 'inactive', current_version_no: 1, created_by: USER, updated_by: USER };
const ver = {
  id: PLN(5), plan_id: PLN(1), version_no: 2, controls_per_run: 2, composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }], mean_rule: '10x', two_two_s_across_runs: true,
  count_rules_across_materials: true, exclude_rejected_runs_from_history: true, run_window_minutes: 30, qc_validity_hours: 24, hold_lookback_hours: 24, change_reason: INJ, effective_from: '2026-11-14T08:00:00.000Z',
  created_by: USER, updated_by: USER,
};
const CALLS: Record<string, (r: any, tx: any) => Promise<unknown>> = {
  listPlans: (r, tx) => r.listPlans(tx, TENANT_A, { instrumentId: INS(1), analyteId: ANA(1), status: 'active', limit: 50 }),
  findPlan: (r, tx) => r.findPlan(tx, TENANT_A, PLN(1)),
  insertPlan: (r, tx) => r.insertPlan(tx, TENANT_A, plan),
  updatePlan: (r, tx) => r.updatePlan(tx, TENANT_A, PLN(1), 1, { status: 'active', current_version_no: 2, updated_by: USER }),
  insertVersion: (r, tx) => r.insertVersion(tx, TENANT_A, ver),
  listVersions: (r, tx) => r.listVersions(tx, TENANT_A, PLN(1)),
  listCurrentVersions: (r, tx) => r.listCurrentVersions(tx, TENANT_A, [PLN(1), PLN(2)]),
  findLevels: (r, tx) => r.findLevels(tx, TENANT_A, [LVL(1), LVL(2)]),
  coveredLevelIds: (r, tx) => r.coveredLevelIds(tx, TENANT_A, PLN(1), [LVL(1), LVL(2)]),
  listInstrumentLabels: (r, tx) => r.listInstrumentLabels(tx, TENANT_A, [INS(1)]),
  listUserLabels: (r, tx) => r.listUserLabels(tx, TENANT_A, [USER]),
};
/** listUserLabels is the OPEN seam of .orchestra/cr/C9.T-15.md (no user-directory view is specified): it may issue no SQL at all, but if it does the same hygiene applies. */
const SQL_METHODS = Object.keys(CALLS).filter((n) => n !== 'listUserLabels');

describe('createPlanRepo: SQL hygiene', () => {
  it('the probe table covers every method of the repo (a new method cannot dodge the checks)', () => { expect(Object.keys(createPlanRepo()).sort()).toEqual(Object.keys(CALLS).sort()); });
  it.each(SQL_METHODS)('%s: every statement names tenant_id, binds the tenant id as a parameter, and carries no request value in the SQL text', async (name) => {
    const { q, tx } = rec(); await CALLS[name]!(createPlanRepo(), tx).catch(() => undefined);
    expect(q.length, 'no SQL issued').toBeGreaterThan(0);
    for (const s of q) {
      expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A);
      expect(s.text).toMatch(/\$1/); expect(s.text).not.toMatch(/DROP TABLE|SIM-|[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(s.text, 'schema-qualified').not.toMatch(/\b(FROM|JOIN|INTO|UPDATE)\s+(?!quality\.|instruments\.|\(|SET\b)\w+/i);
    }
  });
  it('listUserLabels: any SQL it issues is tenant-scoped; no SQL is fine (OPEN seam)', async () => {
    const { q, tx } = rec(); await CALLS['listUserLabels']!(createPlanRepo(), tx).catch(() => undefined);
    for (const s of q) { expect(s.text).toMatch(/tenant_id/); expect(s.values).toContain(TENANT_A); }
  });
  it.each(['insertPlan', 'updatePlan', 'insertVersion'])('%s: tenant_id is only ever a bound parameter taken from the argument (never from the row; no default)', async (name) => {
    const { q, tx } = rec(); await CALLS[name]!(createPlanRepo(), tx).catch(() => undefined);
    for (const s of q) expect(s.values.filter((v) => v === TENANT_A).length).toBeGreaterThanOrEqual(1);
  });
  it('a row that smuggles a tenant_id / is_active / version is not honoured: the tenant bound is the argument', async () => {
    const { q, tx } = rec(); await createPlanRepo().insertPlan(tx, TENANT_A, { ...plan, tenant_id: 'ffffffff-ffff-7fff-8fff-ffffffffffff' } as any).catch(() => undefined);
    for (const s of q) expect(s.values).not.toContain('ffffffff-ffff-7fff-8fff-ffffffffffff');
  });
  it('updatePlan is version-checked in SQL (WHERE version = $n, version = version + 1) so a concurrent writer yields no row, not an overwrite; it only touches quality.qc_plans', async () => {
    const { q, tx } = rec(); await CALLS['updatePlan']!(createPlanRepo(), tx).catch(() => undefined);
    expect(q[0]!.text).toMatch(/UPDATE\s+quality\.qc_plans\b/i); expect(q[0]!.text).toMatch(/version\s*=\s*\$\d+/i); expect(q[0]!.text).toMatch(/version\s*=\s*version\s*\+\s*1|version\s*=\s*\$\d+\s*\+\s*1/i); expect(q[0]!.text).toMatch(/RETURNING/i);
  });
  it('updatePlan returns undefined (not a throw, not a stale row) when no row matched', async () => {
    const { tx } = rec(); expect(await createPlanRepo().updatePlan(tx, TENANT_A, PLN(1), 1, { status: 'active', updated_by: USER })).toBeUndefined();
  });
  it('updatePlan cannot change identity columns: tenant_id, id, instrument_id, test_id, analyte_id never appear in its SET list even if passed', async () => {
    const { q, tx } = rec(); await createPlanRepo().updatePlan(tx, TENANT_A, PLN(1), 1, { status: 'active', tenant_id: 'x', instrument_id: INS(2), analyte_id: ANA(2), id: PLN(2), updated_by: USER } as any).catch(() => undefined);
    const set = q.map((s) => s.text.replace(/\s+/g, ' ')).join(' ').match(/SET (.*?) WHERE/i)?.[1] ?? ''; expect(set).not.toMatch(/\b(tenant_id|instrument_id|analyte_id|test_id)\b|\bid\s*=/);
  });
  it('S-06: qc_plan_versions is INSERT-only — across every method the repo issues no UPDATE or DELETE against it', async () => {
    for (const n of Object.keys(CALLS)) { const { q, tx } = rec(); await CALLS[n]!(createPlanRepo(), tx).catch(() => undefined); for (const s of q) { expect(s.text, n).not.toMatch(/UPDATE\s+quality\.qc_plan_versions/i); expect(s.text, n).not.toMatch(/DELETE\s+FROM\s+quality\.qc_plan_versions|TRUNCATE/i); } }
  });
  it('S-06: no DELETE of any kind and no TRUNCATE in the plan repo (lims_app has no DELETE grant on these tables)', async () => {
    for (const n of Object.keys(CALLS)) { const { q, tx } = rec(); await CALLS[n]!(createPlanRepo(), tx).catch(() => undefined); for (const s of q) expect(s.text, n).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i); }
  });
  it('insertVersion: one INSERT INTO quality.qc_plan_versions with the composition as jsonb and the free-text reason bound, never inlined', async () => {
    const { q, tx } = rec(); await CALLS['insertVersion']!(createPlanRepo(), tx).catch(() => undefined);
    expect(q).toHaveLength(1); expect(q[0]!.text).toMatch(/INSERT\s+INTO\s+quality\.qc_plan_versions/i); expect(q[0]!.text).toMatch(/composition/); expect(q[0]!.text).not.toContain('DROP');
    expect(q[0]!.values.some((v) => v === INJ)).toBe(true);
    expect(q[0]!.values.some((v) => (typeof v === 'string' && v.includes(LVL(1))) || (Array.isArray(v) && JSON.stringify(v).includes(LVL(1))))).toBe(true);   // composition value is a parameter
  });
  it('insertPlan: one INSERT INTO quality.qc_plans', async () => {
    const { q, tx } = rec(); await CALLS['insertPlan']!(createPlanRepo(), tx).catch(() => undefined); expect(q).toHaveLength(1); expect(q[0]!.text).toMatch(/INSERT\s+INTO\s+quality\.qc_plans\b/i);
  });
  it('Postgres unique/foreign-key errors pass through unchanged for the service to map (code + constraint intact)', async () => {
    const err = Object.assign(new Error('dup'), { code: '23505', constraint: 'qc_plans__tenant_instrument_analyte__uq' });
    const tx = { async query() { throw err; } }; await expect(createPlanRepo().insertPlan(tx as any, TENANT_A, plan)).rejects.toMatchObject({ code: '23505', constraint: 'qc_plans__tenant_instrument_analyte__uq' });
  });
  it('listCurrentVersions returns the version whose version_no = the plan\'s current_version_no (join on tenant_id AND plan id, not a MAX() over other tenants)', async () => {
    const { q, tx } = rec(); await CALLS['listCurrentVersions']!(createPlanRepo(), tx);
    expect(q[0]!.text).toMatch(/qc_plan_versions/); expect(q[0]!.text).toMatch(/current_version_no/); expect(q[0]!.text).toMatch(/version_no/);
    expect((q[0]!.text.match(/tenant_id/g) ?? []).length, 'tenant predicate on both joined tables').toBeGreaterThanOrEqual(2);
  });
  it('listVersions is scoped to one plan and ordered by version_no', async () => {
    const { q, tx } = rec(); await CALLS['listVersions']!(createPlanRepo(), tx); expect(q[0]!.values).toContain(PLN(1)); expect(q[0]!.text).toMatch(/ORDER BY[^;]*version_no/i);
  });
  it('coveredLevelIds (activation guard): joins qc_targets to control_lots, requires an ACTIVE target on an is_active lot of THIS plan, tenant predicate on both tables', async () => {
    const { q, tx } = rec(); await CALLS['coveredLevelIds']!(createPlanRepo(), tx);
    const t = q[0]!.text; expect(t).toMatch(/quality\.qc_targets/); expect(t).toMatch(/quality\.control_lots/); expect(t).toMatch(/is_active/); expect(t).toMatch(/plan_id/); expect(t).toMatch(/level_id/);
    expect(t.includes("'active'") || q[0]!.values.includes('active'), 'status = active').toBe(true); expect(q[0]!.values).toContain(PLN(1)); expect((t.match(/tenant_id/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('coveredLevelIds returns [] for an empty result and plain ids (strings) otherwise', async () => {
    const { tx } = rec(); expect(await createPlanRepo().coveredLevelIds(tx, TENANT_A, PLN(1), [LVL(1)])).toEqual([]);
    const tx2 = { async query() { return { rows: [{ level_id: LVL(1) }, { level_id: LVL(2) }], rowCount: 2 }; } }; expect(await createPlanRepo().coveredLevelIds(tx2 as any, TENANT_A, PLN(1), [LVL(1), LVL(2)])).toEqual([LVL(1), LVL(2)]);
  });
  it('findLevels / listInstrumentLabels with an empty id list do not issue an invalid "IN ()" (either no SQL or a parameterised ANY($n))', async () => {
    for (const n of ['findLevels', 'listInstrumentLabels']) { const { q, tx } = rec(); await (createPlanRepo() as any)[n](tx, TENANT_A, []); for (const s of q) expect(s.text).not.toMatch(/IN\s*\(\s*\)/i); }
  });
  it('lists are keyset-paged with an id tie-breaker and limit+1 look-ahead (02-CV §4.3): ORDER BY ends with id; LIMIT is a parameter', async () => {
    const { q, tx } = rec(); await CALLS['listPlans']!(createPlanRepo(), tx); expect(q[0]!.text).toMatch(/ORDER BY[^;]*\bid\b/i); expect(q[0]!.text).toMatch(/LIMIT\s+\$\d+/i);
  });
  it('listPlans binds the filters (status, instrument, analyte) as parameters and never inlines them', async () => {
    const { q, tx } = rec(); await CALLS['listPlans']!(createPlanRepo(), tx); expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, INS(1), ANA(1)])); expect(q[0]!.text).not.toMatch(/'active'|'inactive'/);
  });
  it('a malformed cursor is common.invalid_cursor, not a SQL error', async () => {
    const { tx } = rec(); const repo: any = createPlanRepo();
    for (const c of ['%%%', 'x'.repeat(600), '{"a":1}']) await expect(repo.listPlans(tx, TENANT_A, { cursor: c, limit: 5 })).rejects.toMatchObject({ code: 'common.invalid_cursor' });
  });
  it('listInstrumentLabels reads only the invoker view instruments.v_pub_instrument_directory (never instruments.instruments directly, R25/P-21)', async () => {
    const { q, tx } = rec(); await CALLS['listInstrumentLabels']!(createPlanRepo(), tx); expect(q[0]!.text).toMatch(/instruments\.v_pub_instrument_directory/); expect(q[0]!.text).not.toMatch(/instruments\.instruments\b/);
  });
});
