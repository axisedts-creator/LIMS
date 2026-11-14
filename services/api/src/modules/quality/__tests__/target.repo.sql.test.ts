// C9 T-08 — the REAL repo (createTargetRepo) driven with a recording tx (no database): every statement is tenant-scoped and parameterised (REQ-SEC-022/024/082), qc_targets values are
// never updated (05-SCHEMA §4: trigger qc_targets__mutable_columns; S-09), updates are version-checked, nothing is deleted. RLS and the trigger itself (tenants A/B on the real DDL)
// are proven by db/tests once C0 merges the quality DDL.
import { describe, expect, it } from 'vitest';
import { createTargetRepo } from '../repository/target.repo.js';
import { LOT, LVL, MUTABLE, OBS, PLN, TENANT_A, TGT, USER, FROM, TO, pgErr, immutableRow } from './target.helpers.js';

const rec = () => {
  const q: Array<{ text: string; values: unknown[] }> = [];
  return { q, tx: { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows: [], rowCount: 0 }; } } };
};
const INJ = `x'; DROP TABLE quality.qc_targets; --`;
const SHA = 'a'.repeat(63) + 'b';
const manual = { id: TGT(1), plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), mean: '100.0', sd: '2.0', unit_code: 'mmol_l', source: 'manufacturer', note: INJ, status: 'draft', created_by: USER, updated_by: USER };
const established = { ...manual, id: TGT(2), source: 'established', note: undefined, basis_n: 25, basis_from: FROM, basis_to: TO, basis_observation_ids_sha256: SHA };
const CALLS: Record<string, (r: any, tx: any) => Promise<unknown>> = {
  listTargets: (r, tx) => r.listTargets(tx, TENANT_A, { planId: PLN(1), lotId: LOT(1), statuses: ['draft', 'active'], limit: 50 }),
  findTarget: (r, tx) => r.findTarget(tx, TENANT_A, TGT(1)),
  findActiveTarget: (r, tx) => r.findActiveTarget(tx, TENANT_A, PLN(1), LOT(1)),
  insertTarget: (r, tx) => r.insertTarget(tx, TENANT_A, manual),
  updateTarget: (r, tx) => r.updateTarget(tx, TENANT_A, TGT(1), 1, { status: 'superseded', effective_to: TO, updated_by: USER }),
  findPlan: (r, tx) => r.findPlan(tx, TENANT_A, PLN(1)),
  currentComposition: (r, tx) => r.currentComposition(tx, TENANT_A, PLN(1)),
  findLot: (r, tx) => r.findLot(tx, TENANT_A, LOT(1)),
  listEstablishCandidates: (r, tx) => r.listEstablishCandidates(tx, TENANT_A, { planId: PLN(1), lotId: LOT(1), from: FROM, to: TO }),
  getSettings: (r, tx) => r.getSettings(tx, TENANT_A),
  listUserLabels: (r, tx) => r.listUserLabels(tx, TENANT_A, [USER]),
};
/** listUserLabels is the OPEN seam of .orchestra/cr/C9.T-15.md (no user-directory view is specified): it may issue no SQL at all, but if it does the same hygiene applies. */
const SQL_METHODS = Object.keys(CALLS).filter((n) => n !== 'listUserLabels');
const flat = (q: Array<{ text: string }>) => q.map((s) => s.text.replace(/\s+/g, ' ')).join(' ; ');

describe('createTargetRepo: SQL hygiene', () => {
  it('the probe table covers every method of the repo (a new method cannot dodge the checks)', () => { expect(Object.keys(createTargetRepo()).sort()).toEqual(Object.keys(CALLS).sort()); });
  it.each(SQL_METHODS)('%s: every statement names tenant_id, binds the tenant id as a parameter, carries no request value in the SQL text, and is schema-qualified quality.*', async (name) => {
    const { q, tx } = rec(); await CALLS[name]!(createTargetRepo(), tx).catch(() => undefined);
    expect(q.length, 'no SQL issued').toBeGreaterThan(0);
    for (const s of q) {
      expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A);
      expect(s.text).toMatch(/\$1/); expect(s.text).not.toMatch(/DROP TABLE|mmol|LOT-SYN|[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(s.text, 'schema-qualified').not.toMatch(/\b(FROM|JOIN|INTO|UPDATE)\s+(?!quality\.|\(|SET\b)\w+/i);
    }
  });
  it('listUserLabels: any SQL it issues is tenant-scoped; no SQL is fine (OPEN seam)', async () => {
    const { q, tx } = rec(); await CALLS['listUserLabels']!(createTargetRepo(), tx).catch(() => undefined);
    for (const s of q) { expect(s.text).toMatch(/tenant_id/); expect(s.values).toContain(TENANT_A); }
  });
  it.each(['insertTarget', 'updateTarget'])('%s: tenant_id is only ever a bound parameter taken from the argument (never from the row; no default)', async (name) => {
    const { q, tx } = rec(); await CALLS[name]!(createTargetRepo(), tx).catch(() => undefined);
    for (const s of q) expect(s.values.filter((v) => v === TENANT_A).length).toBeGreaterThanOrEqual(1);
  });
  it('a row that smuggles a tenant_id / is_active / version is not honoured: the tenant bound is the argument', async () => {
    const { q, tx } = rec(); const other = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
    await createTargetRepo().insertTarget(tx, TENANT_A, { ...manual, tenant_id: other, is_active: false, version: 9 } as any).catch(() => undefined); for (const s of q) { expect(s.values).not.toContain(other); expect(s.values).not.toContain(false); expect(s.values).not.toContain(9); }
  });
  it('S-09/AB-01: across every method the repo never issues DELETE or TRUNCATE (lims_app has no DELETE grant), and only ever UPDATEs quality.qc_targets', async () => {
    for (const n of Object.keys(CALLS)) {
      const { q, tx } = rec(); await CALLS[n]!(createTargetRepo(), tx).catch(() => undefined);
      for (const s of q) { expect(s.text, n).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i); for (const m of s.text.matchAll(/UPDATE\s+([\w.]+)/gi)) expect(m[1], n).toBe('quality.qc_targets'); }
    }
  });
  it('the repo never touches observations or runs with a write: INSERT/UPDATE only target quality.qc_targets (observations keep their own mean/SD snapshot, AC-04.5)', async () => {
    for (const n of Object.keys(CALLS)) { const { q, tx } = rec(); await CALLS[n]!(createTargetRepo(), tx).catch(() => undefined); for (const s of q) for (const m of s.text.matchAll(/(?:INSERT\s+INTO|UPDATE)\s+([\w.]+)/gi)) expect(m[1], n).toBe('quality.qc_targets'); }
  });
});

describe('createTargetRepo: writes', () => {
  it('insertTarget (manufacturer): one INSERT INTO quality.qc_targets, every value (incl. the free-text note) bound, never inlined; no basis value bound', async () => {
    const { q, tx } = rec(); await CALLS['insertTarget']!(createTargetRepo(), tx).catch(() => undefined);
    expect(q).toHaveLength(1); expect(q[0]!.text).toMatch(/INSERT\s+INTO\s+quality\.qc_targets\b/i); expect(q[0]!.text).not.toContain('DROP'); expect(q[0]!.values).toEqual(expect.arrayContaining([TGT(1), PLN(1), LOT(1), LVL(1), '100.0', '2.0', 'mmol_l', 'manufacturer', INJ, USER]));
    expect(q[0]!.values).not.toContain(SHA);
  });
  it('insertTarget (established): the basis columns are written with the digest bound as a parameter (qc_targets__basis__ck / basis_sha__ck)', async () => {
    const { q, tx } = rec(); await createTargetRepo().insertTarget(tx, TENANT_A, established as any).catch(() => undefined);
    expect(q).toHaveLength(1); for (const c of ['basis_n', 'basis_from', 'basis_to', 'basis_observation_ids_sha256']) expect(q[0]!.text, c).toMatch(new RegExp(`\\b${c}\\b`)); expect(q[0]!.values).toEqual(expect.arrayContaining([25, FROM, TO, SHA, 'established'])); expect(q[0]!.text).not.toContain(SHA);
  });
  it('insertTarget returns the stored row (RETURNING) and rejects columns that are not part of the row contract instead of splicing them into the SQL', async () => {
    const { q, tx } = rec(); await createTargetRepo().insertTarget(tx, TENANT_A, { ...manual, 'mean) VALUES (1); --': 'x' } as any).catch(() => undefined);
    expect(flat(q)).not.toContain('VALUES (1); --'); if (q.length) expect(q[0]!.text).toMatch(/RETURNING/i);
  });
  it('updateTarget is version-checked in SQL (WHERE version = $n, version = version + 1) so a concurrent writer yields no row, not an overwrite; it only touches quality.qc_targets and RETURNs', async () => {
    const { q, tx } = rec(); await CALLS['updateTarget']!(createTargetRepo(), tx).catch(() => undefined);
    expect(q[0]!.text).toMatch(/UPDATE\s+quality\.qc_targets\b/i); expect(q[0]!.text).toMatch(/\bversion\s*=\s*\$\d+/i); expect(q[0]!.text).toMatch(/version\s*=\s*version\s*\+\s*1|version\s*=\s*\$\d+\s*\+\s*1/i); expect(q[0]!.text).toMatch(/RETURNING/i);
    expect(q[0]!.values).toEqual(expect.arrayContaining([TGT(1), 1, 'superseded', TO, USER]));
  });
  it('updateTarget returns undefined (not a throw, not a stale row) when no row matched', async () => {
    const { tx } = rec(); expect(await createTargetRepo().updateTarget(tx, TENANT_A, TGT(1), 1, { status: 'active', updated_by: USER })).toBeUndefined();
  });
  it('updateTarget returns the updated row when one matched', async () => {
    const tx = { async query() { return { rows: [{ id: TGT(1), status: 'superseded', version: 2 }], rowCount: 1 }; } }; expect(await createTargetRepo().updateTarget(tx as any, TENANT_A, TGT(1), 1, { status: 'superseded', updated_by: USER })).toMatchObject({ id: TGT(1), status: 'superseded', version: 2 });
  });
  it('AC-04.6 / S-09: even if asked, updateTarget never SETs mean, sd, plan_id, lot_id, level_id, unit_code, source, basis_*, note, tenant_id, id or created_* — only the trigger\'s lifecycle columns', async () => {
    const { q, tx } = rec();
    await createTargetRepo().updateTarget(tx, TENANT_A, TGT(1), 1, { status: 'active', effective_from: FROM, mean: '1', sd: '9', plan_id: PLN(2), lot_id: LOT(2), level_id: LVL(2), unit_code: 'x', source: 'established', basis_n: 3, basis_from: FROM, basis_to: TO, basis_observation_ids_sha256: SHA, note: 'n', tenant_id: 'x', id: TGT(2), created_by: USER, created_at: FROM, is_active: false, updated_by: USER } as any).catch(() => undefined);
    const set = flat(q).match(/SET (.*?) WHERE/i)?.[1] ?? ''; expect(set).toMatch(/\bstatus\b/); expect(set).toMatch(/\beffective_from\b/); expect(set).toMatch(/\bupdated_by\b/);
    expect(set).not.toMatch(/\b(mean|sd|plan_id|lot_id|level_id|unit_code|source|basis_n|basis_from|basis_to|basis_observation_ids_sha256|note|tenant_id|created_by|created_at|is_active)\b|\bid\s*=/);
    for (const col of set.matchAll(/\b([a-z_]+)\s*=/g)) expect([...MUTABLE, 'version'], col[1]).toContain(col[1]);
  });
  it('every lifecycle column of the trigger allow-list can be set (activation: status, effective_from, effective_to, activated_at, activated_by; retire: retired_at, retired_by, retire_reason)', async () => {
    const { q, tx } = rec(); await createTargetRepo().updateTarget(tx, TENANT_A, TGT(1), 1, { status: 'retired', effective_from: FROM, effective_to: TO, activated_at: FROM, activated_by: USER, retired_at: TO, retired_by: USER, retire_reason: INJ, updated_by: USER }).catch(() => undefined);
    const set = flat(q).match(/SET (.*?) WHERE/i)?.[1] ?? ''; for (const c of ['status', 'effective_from', 'effective_to', 'activated_at', 'activated_by', 'retired_at', 'retired_by', 'retire_reason', 'updated_by']) expect(set, c).toMatch(new RegExp(`\\b${c}\\s*=`));
    expect(q[0]!.values).toContain(INJ); expect(q[0]!.text).not.toContain('DROP');
  });
  it('an empty patch is not turned into invalid SQL ("SET  WHERE"): it either issues no statement or still bumps version/updated_at', async () => {
    const { q, tx } = rec(); await createTargetRepo().updateTarget(tx, TENANT_A, TGT(1), 1, {}).catch(() => undefined); for (const s of q) expect(s.text.replace(/\s+/g, ' ')).not.toMatch(/SET\s+WHERE/i);
  });
  it('Postgres errors pass through UNCHANGED for the service to map: unique (active-per-key index), CHECK, and the trigger P0001 immutable_row', async () => {
    for (const err of [pgErr('23505', 'qc_targets__tenant_plan_lot_active__p_uq'), pgErr('23514', 'qc_targets__sd__ck'), immutableRow(), pgErr('23503', 'qc_targets__lot__fk')]) {
      const tx = { async query() { throw err; } }; await expect(createTargetRepo().updateTarget(tx as any, TENANT_A, TGT(1), 1, { status: 'active', updated_by: USER })).rejects.toBe(err);
      await expect(createTargetRepo().insertTarget(tx as any, TENANT_A, manual as any)).rejects.toBe(err);
    }
  });
});

describe('createTargetRepo: reads', () => {
  it('findActiveTarget: tenant + plan + lot bound, status = active (literal or bound), at most one row', async () => {
    const { q, tx } = rec(); await CALLS['findActiveTarget']!(createTargetRepo(), tx); expect(q[0]!.text).toMatch(/quality\.qc_targets/); expect(q[0]!.text).toMatch(/plan_id/); expect(q[0]!.text).toMatch(/lot_id/);
    expect(q[0]!.text.includes("'active'") || q[0]!.values.includes('active'), 'status = active').toBe(true); expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, PLN(1), LOT(1)]));
  });
  it('listTargets: filters bound as parameters (never inlined), status list as one bound array/params, keyset order ends with id, LIMIT is a parameter', async () => {
    const { q, tx } = rec(); await CALLS['listTargets']!(createTargetRepo(), tx);
    expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, PLN(1), LOT(1)])); expect(q[0]!.text).not.toMatch(/'draft'|'active'|'superseded'/); expect(q[0]!.values.some((v) => Array.isArray(v) ? v.includes('draft') : v === 'draft')).toBe(true);
    expect(q[0]!.text).toMatch(/ORDER BY[^;]*\bid\b/i); expect(q[0]!.text).toMatch(/LIMIT\s+\$\d+/i); expect(q[0]!.text).not.toMatch(/IN\s*\(\s*\)/i);
  });
  it('listTargets without filters is still tenant-scoped and valid', async () => {
    const { q, tx } = rec(); await createTargetRepo().listTargets(tx, TENANT_A, { limit: 10 }); expect(q[0]!.text).toMatch(/tenant_id\s*=\s*\$1/); expect(q[0]!.text).not.toMatch(/WHERE\s+AND|AND\s+AND|AND\s*(ORDER|LIMIT)/i);
  });
  it('a malformed cursor is common.invalid_cursor, not a SQL error', async () => {
    const { tx } = rec(); const repo: any = createTargetRepo();
    for (const c of ['%%%', 'x'.repeat(600), '{"a":1}']) await expect(repo.listTargets(tx, TENANT_A, { cursor: c, limit: 5 })).rejects.toMatchObject({ code: 'common.invalid_cursor' });
  });
  it('listEstablishCandidates reads quality.qc_observations (joined to the run outcome) for ONE tenant, plan, lot and observed_at range — every value a parameter; read-only; the result carries id, value, status, observed_at, run_outcome', async () => {
    const { q, tx } = rec(); await CALLS['listEstablishCandidates']!(createTargetRepo(), tx); const t = q[0]!.text;
    expect(q).toHaveLength(1); expect(t).toMatch(/quality\.qc_observations/); expect(t).toMatch(/observed_at/); expect(t).toMatch(/plan_id/); expect(t).toMatch(/lot_id/); expect(t).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, PLN(1), LOT(1), FROM, TO])); if (/qc_runs/.test(t)) expect((t.match(/tenant_id/g) ?? []).length, 'tenant predicate on both joined tables').toBeGreaterThanOrEqual(2);
    expect(t).toMatch(/\bvalue\b/); expect(t).toMatch(/\bstatus\b/); expect(t).toMatch(/outcome/);
  });
  it('listEstablishCandidates never reads lab.* or the source QC tables directly, and does not filter by status in the repo (the service owns the population rule)', async () => {
    const { q, tx } = rec(); await CALLS['listEstablishCandidates']!(createTargetRepo(), tx); expect(q[0]!.text).not.toMatch(/\blab\./i); expect(q[0]!.text).not.toMatch(/status\s*(=|IN)\s*'(assigned|no_target|accepted)/i);
  });
  it('listEstablishCandidates returns the rows as plain objects ([] for none; value stays a string)', async () => {
    const { tx } = rec(); expect(await createTargetRepo().listEstablishCandidates(tx, TENANT_A, { planId: PLN(1), lotId: LOT(1), from: FROM, to: TO })).toEqual([]);
    const row = { id: OBS(1), value: '100.1', status: 'assigned', observed_at: FROM, run_outcome: 'accepted' }; const tx2 = { async query() { return { rows: [row], rowCount: 1 }; } };
    const [r] = await createTargetRepo().listEstablishCandidates(tx2 as any, TENANT_A, { planId: PLN(1), lotId: LOT(1), from: FROM, to: TO }); expect(r).toMatchObject({ id: OBS(1), status: 'assigned', run_outcome: 'accepted' }); expect(typeof r!['value']).toBe('string');
  });
  it('currentComposition: the composition of the version whose version_no = the plan\'s current_version_no (tenant predicate on both qc_plans and qc_plan_versions); undefined for an unknown plan', async () => {
    const { q, tx } = rec(); await CALLS['currentComposition']!(createTargetRepo(), tx); const t = q[0]!.text;
    expect(t).toMatch(/qc_plan_versions/); expect(t).toMatch(/current_version_no/); expect(t).toMatch(/composition/); expect((t.match(/tenant_id/g) ?? []).length).toBeGreaterThanOrEqual(2); expect(q[0]!.values).toContain(PLN(1));
    expect(await createTargetRepo().currentComposition(tx, TENANT_A, PLN(1))).toBeUndefined();
  });
  it('findLot reads quality.control_lots; findPlan reads quality.qc_plans; getSettings reads quality.settings — each by tenant and id only', async () => {
    for (const [n, tbl, vals] of [['findLot', 'quality.control_lots', [LOT(1)]], ['findPlan', 'quality.qc_plans', [PLN(1)]], ['getSettings', 'quality.settings', []]] as const) {
      const { q, tx } = rec(); await CALLS[n]!(createTargetRepo(), tx); expect(q[0]!.text, n).toContain(tbl); expect(q[0]!.values, n).toEqual(expect.arrayContaining([TENANT_A, ...vals]));
    }
  });
  it('finders return undefined when nothing matched and the plain row when it did', async () => {
    const { tx } = rec(); const repo: any = createTargetRepo(); for (const n of ['findTarget', 'findPlan', 'findLot', 'getSettings']) expect(await CALLS[n]!(repo, tx), n).toBeUndefined();
    const tx2 = { async query() { return { rows: [{ id: TGT(1), status: 'active' }], rowCount: 1 }; } }; expect(await repo.findTarget(tx2, TENANT_A, TGT(1))).toMatchObject({ id: TGT(1), status: 'active' });
  });
  it('findTarget takes ONE id: tenant + id predicates, both bound', async () => {
    const { q, tx } = rec(); await CALLS['findTarget']!(createTargetRepo(), tx); expect(q[0]!.text).toMatch(/quality\.qc_targets/); expect(q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, TGT(1)]));
  });
});
