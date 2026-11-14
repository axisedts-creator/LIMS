// C9 T-10 — repository/run.repo.ts SQL pins (no database; real-PG behaviour -> db/tests, not covered here). The fake RunRepo in run.helpers.ts implements these contracts, so
// the filters that decide H1-H4, AS1 and the gauge are pinned HERE against the real statements: tenant predicate on every statement (REQ-SEC-024), parameterised values only, schema `quality` only (never lab.*).
// Column names are 05-SCHEMA §qc_runs / qc_observations / qc_activity / qc_corrective_actions verbatim. Result columns read back: latestInControlRunAt -> `run_at`, oldestRejectedWithoutActionAt -> `evaluated_at`.
// Fails now: "Cannot find module ../repository/run.repo.js".
import { describe, expect, it } from 'vitest';
import { createRunRepo } from '../repository/run.repo.js';
import { PLN, RUN, TENANT_A, at, idN } from './run.helpers.js';

const SENTINEL = "x'; DROP TABLE quality.qc_runs;--";
function tx(rows: any[] = [{ id: RUN(1), version: 2, run_at: at('06:00:00'), evaluated_at: at('06:00:00') }]) {
  const q: Array<{ text: string; values: unknown[] }> = [];
  return { q, tx: { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows }; } } as any };
}
const sql = (t: ReturnType<typeof tx>) => t.q.map((x) => x.text).join('\n;\n');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const repo = createRunRepo();

describe('every statement: tenant predicate, bind parameters, schema quality only', () => {
  const calls: Array<[string, (r: typeof repo, t: any) => Promise<unknown>]> = [
    ['lockPlan', (r, t) => r.lockPlan(t, TENANT_A, PLN(1))],
    ['findCollectingRun', (r, t) => r.findCollectingRun(t, TENANT_A, PLN(1))],
    ['findLatestEarlyRejectedRun', (r, t) => r.findLatestEarlyRejectedRun(t, TENANT_A, PLN(1))],
    ['listCollectingRuns', (r, t) => r.listCollectingRuns(t, TENANT_A)],
    ['insertRun', (r, t) => r.insertRun(t, TENANT_A, { id: RUN(1), tenant_id: TENANT_A, plan_id: PLN(1), status: 'collecting', rules_violated: [], warning_rules: [], rule_detail: [], run_at: at('08:00:00') })],
    ['updateRun', (r, t) => r.updateRun(t, TENANT_A, RUN(1), { observation_count: 2, last_assembled_at: at('08:05:00') })],
    ['listRunMembers', (r, t) => r.listRunMembers(t, TENANT_A, RUN(1))],
    ['listHistory', (r, t) => r.listHistory(t, TENANT_A, PLN(1), { excludeRunId: RUN(1), excludeRejectedRuns: true, limit: 200 })],
    ['latestInControlRunAt', (r, t) => r.latestInControlRunAt(t, TENANT_A, PLN(1), at('09:00:00'))],
    ['resetQcActivity', (r, t) => r.resetQcActivity(t, TENANT_A, PLN(1), at('08:00:00'))],
    ['oldestRejectedWithoutActionAt', (r, t) => r.oldestRejectedWithoutActionAt(t, TENANT_A)],
  ];
  it.each(calls)('%s', async (_n, call) => {
    const t = tx();
    await call(repo, t.tx);
    expect(t.q.length).toBeGreaterThan(0);
    for (const s of t.q) {
      expect(s.text, 'tenant predicate').toMatch(/tenant_id\s*=\s*\$\d+/i);
      expect(s.values).toContain(TENANT_A);
      expect(s.text).not.toMatch(/\blab\./i);
      expect(s.text).not.toContain(TENANT_A);
      expect(s.text).not.toContain(PLN(1));
      expect(s.text).not.toContain(RUN(1));
    }
  });
  it('hostile ids are bound, never interpolated', async () => {
    const t = tx();
    await repo.findCollectingRun(t.tx, TENANT_A, SENTINEL);
    await repo.listRunMembers(t.tx, TENANT_A, SENTINEL);
    await repo.latestInControlRunAt(t.tx, TENANT_A, SENTINEL, SENTINEL);
    for (const s of t.q) { expect(s.text).not.toContain('DROP TABLE'); expect(s.values).toContain(SENTINEL); }
  });
});

describe('pair lock', () => {
  it('lockPlan = SELECT ... FROM quality.qc_plans ... FOR UPDATE joined to the plan\'s current version (run params), by tenant and plan id', async () => {
    const t = tx([{ plan_id: PLN(1), version_no: 3 }]);
    await repo.lockPlan(t.tx, TENANT_A, PLN(1));
    const s = flat(sql(t));
    expect(t.q).toHaveLength(1);
    expect(s).toMatch(/FROM quality\.qc_plans/i);
    expect(s).toMatch(/qc_plan_versions/i);
    expect(s).toMatch(/FOR UPDATE/i);
    for (const col of ['controls_per_run', 'composition', 'mean_rule', 'two_two_s_across_runs', 'count_rules_across_materials', 'exclude_rejected_runs_from_history', 'run_window_minutes', 'hold_lookback_hours']) expect(s, col).toContain(col);
    expect(t.q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, PLN(1)]));
  });
  it('lockPlan answers undefined when the plan is not visible (no row)', async () => {
    expect(await repo.lockPlan(tx([]).tx, TENANT_A, PLN(1))).toBeUndefined();
  });
});

describe('run lookups', () => {
  it('findCollectingRun: status = collecting of the plan', async () => {
    const t = tx(); await repo.findCollectingRun(t.tx, TENANT_A, PLN(1));
    expect(flat(sql(t))).toMatch(/FROM quality\.qc_runs/i);
    expect(flat(sql(t))).toMatch(/status\s*=\s*'collecting'/i);
    expect(flat(sql(t))).toMatch(/plan_id\s*=\s*\$\d+/i);
  });
  it('findLatestEarlyRejectedRun (D-52 step 1a): evaluated AND rejected AND is_complete = false, latest run_at first, one row', async () => {
    const t = tx(); await repo.findLatestEarlyRejectedRun(t.tx, TENANT_A, PLN(1));
    const s = flat(sql(t));
    expect(s).toMatch(/status\s*=\s*'evaluated'/i);
    expect(s).toMatch(/outcome\s*=\s*'rejected'/i);
    expect(s).toMatch(/is_complete\s*(=\s*false|IS\s+FALSE)|NOT\s+is_complete/i);
    expect(s).toMatch(/ORDER BY\s+(\w+\.)?run_at\s+DESC/i);
    expect(s).toMatch(/LIMIT\s+1\b/i);
  });
  it('listCollectingRuns carries the plan\'s run_window_minutes and no row lock (the lock is per pair, taken afterwards)', async () => {
    const t = tx(); await repo.listCollectingRuns(t.tx, TENANT_A);
    const s = flat(sql(t));
    expect(s).toMatch(/status\s*=\s*'collecting'/i);
    expect(s).toContain('run_window_minutes');
    expect(s).toMatch(/qc_plan_versions/i);
    expect(s).not.toMatch(/FOR UPDATE/i);
  });
  it('latestInControlRunAt (H1-H4): outcome IN (accepted, accepted_warning) only — never incomplete or rejected —, run_at < the rejected run, latest first, one row; any age', async () => {
    const t = tx(); const v = await repo.latestInControlRunAt(t.tx, TENANT_A, PLN(1), at('09:00:00'));
    const s = flat(sql(t));
    expect(s).toMatch(/outcome\s+IN\s*\(\s*'accepted'\s*,\s*'accepted_warning'\s*\)/i);
    expect(s).not.toMatch(/incomplete|rejected/i);
    expect(s).toMatch(/run_at\s*<\s*\$\d+/i);
    expect(s).toMatch(/ORDER BY\s+(\w+\.)?run_at\s+DESC/i);
    expect(s).toMatch(/LIMIT\s+1\b/i);
    expect(s).not.toMatch(/interval|now\(\)/i);                // no age cut-off (H4)
    expect(t.q[0]!.values).toContain(at('09:00:00'));
    expect(v).toBe(at('06:00:00'));
    expect(await repo.latestInControlRunAt(tx([]).tx, TENANT_A, PLN(1), at('09:00:00'))).toBeUndefined();
  });
});

describe('members and history', () => {
  it('listRunMembers: assigned observations of the run only (excluded ones skipped, V25), oldest first, with the evaluation columns', async () => {
    const t = tx(); await repo.listRunMembers(t.tx, TENANT_A, RUN(1));
    const s = flat(sql(t));
    expect(s).toMatch(/FROM quality\.qc_observations/i);
    expect(s).toMatch(/status\s*=\s*'assigned'/i);
    expect(s).toMatch(/qc_run_id\s*=\s*\$\d+/i);
    expect(s).toMatch(/ORDER BY[^;]*observed_at/i);
    for (const col of ['level_id', 'value', 'mean', 'sd', 'observed_at']) expect(s, col).toContain(col);
  });
  it('listHistory: assigned observations of the plan outside the run, bounded, oldest-first result; excludeRejectedRuns adds the rejected-run filter, false omits it', async () => {
    const on = tx(); await repo.listHistory(on.tx, TENANT_A, PLN(1), { excludeRunId: RUN(1), excludeRejectedRuns: true, limit: 123 });
    const off = tx(); await repo.listHistory(off.tx, TENANT_A, PLN(1), { excludeRunId: RUN(1), excludeRejectedRuns: false, limit: 123 });
    for (const t of [on, off]) {
      const s = flat(sql(t));
      expect(s).toMatch(/status\s*=\s*'assigned'/i);
      expect(s).toMatch(/plan_id\s*=\s*\$\d+/i);
      expect(s).toMatch(/qc_run_id\s*(<>|!=|IS DISTINCT FROM)\s*\$\d+/i);
      expect(s).toMatch(/LIMIT\s+\$\d+/i);
      expect(s).toMatch(/ORDER BY[^;]*observed_at/i);
      expect(t.q[0]!.values).toEqual(expect.arrayContaining([RUN(1), 123]));
    }
    expect(flat(sql(on))).toMatch(/'rejected'/i);
    expect(flat(sql(off))).not.toMatch(/'rejected'/i);
  });
});

describe('writes', () => {
  it('insertRun: INSERT INTO quality.qc_runs with one bound value per column, tenant from the argument', async () => {
    const t = tx();
    await repo.insertRun(t.tx, TENANT_A, { id: RUN(1), tenant_id: TENANT_A, plan_id: PLN(1), status: 'collecting', rules_violated: [], run_at: at('08:00:00') });
    expect(flat(sql(t))).toMatch(/^INSERT INTO quality\.qc_runs/i);
    expect(t.q[0]!.values).toEqual(expect.arrayContaining([RUN(1), TENANT_A, PLN(1), 'collecting', at('08:00:00')]));
  });
  it('insertRun refuses a row of another tenant (argument and row must agree) without a query', async () => {
    const t = tx();
    await expect(repo.insertRun(t.tx, TENANT_A, { id: RUN(1), tenant_id: idN(0xb1), plan_id: PLN(1), status: 'collecting' })).rejects.toBeInstanceOf(Error);
    expect(t.q).toEqual([]);
  });
  it('updateRun: UPDATE quality.qc_runs SET <patch>, version = version + 1 WHERE tenant_id AND id, RETURNING the row', async () => {
    const t = tx([{ id: RUN(1), version: 2 }]);
    const row = await repo.updateRun(t.tx, TENANT_A, RUN(1), { observation_count: 2, last_assembled_at: at('08:05:00') });
    const s = flat(sql(t));
    expect(s).toMatch(/^UPDATE quality\.qc_runs SET/i);
    expect(s).toMatch(/version\s*=\s*version\s*\+\s*1/i);
    expect(s).toMatch(/WHERE[^;]*tenant_id\s*=\s*\$\d+[^;]*\bid\s*=\s*\$\d+|WHERE[^;]*\bid\s*=\s*\$\d+[^;]*tenant_id\s*=\s*\$\d+/i);
    expect(s).toMatch(/RETURNING/i);
    expect(t.q[0]!.values).toEqual(expect.arrayContaining([2, at('08:05:00'), RUN(1), TENANT_A]));
    expect(row).toMatchObject({ id: RUN(1), version: 2 });
  });
  it('updateRun: only run columns of the allowlist are written — tenant_id, id, created_*, unknown and injection keys throw BEFORE any query', async () => {
    for (const k of ['tenant_id', 'id', 'created_by', 'created_at', 'plan_id', `x = 1; DROP TABLE quality.qc_runs; --`, 'version']) {
      const t = tx();
      await expect(repo.updateRun(t.tx, TENANT_A, RUN(1), { [k]: 'v' }), k).rejects.toBeInstanceOf(Error);
      expect(t.q, k).toEqual([]);
    }
  });
  it('updateRun: a run that is not visible (no row returned) rejects instead of pretending success', async () => {
    await expect(repo.updateRun(tx([]).tx, TENANT_A, RUN(1), { observation_count: 2 })).rejects.toBeInstanceOf(Error);
  });
  it('updateRun can write every column the service patches (status, outcome, is_complete, rules_violated, warning_rules, rule_detail, evaluated_*, hold, rejection_event_id)', async () => {
    const t = tx([{ id: RUN(1), version: 2 }]);
    await repo.updateRun(t.tx, TENANT_A, RUN(1), { status: 'evaluated', outcome: 'rejected', is_complete: false, rules_violated: ['1-3s'], warning_rules: ['1-2s'], rule_detail: [{ rule: '1-3s', observation_ids: [idN(1)] }],
      evaluated_at: at('08:00:05'), evaluated_by: idN(2), last_in_control_run_at: null, hold_since: at('06:00:00'), rejection_event_id: idN(3), observation_count: 1, last_member_received_at: at('08:00:00'), last_assembled_at: at('08:00:05') });
    const s = flat(sql(t));
    for (const col of ['status', 'outcome', 'is_complete', 'rules_violated', 'warning_rules', 'rule_detail', 'evaluated_at', 'evaluated_by', 'last_in_control_run_at', 'hold_since', 'rejection_event_id', 'observation_count']) expect(s, col).toContain(col);
  });
  it('resetQcActivity: upsert on (tenant_id, plan_id): last_qc_run_at = the run_at, patient_results_since_last_qc = 0', async () => {
    const t = tx(); await repo.resetQcActivity(t.tx, TENANT_A, PLN(1), at('08:00:00'));
    const s = flat(sql(t));
    expect(s).toMatch(/INSERT INTO quality\.qc_activity/i);
    expect(s).toMatch(/ON CONFLICT\s*\(\s*tenant_id\s*,\s*plan_id\s*\)\s*DO UPDATE/i);
    expect(s).toMatch(/patient_results_since_last_qc\s*=\s*0/i);
    expect(s).toMatch(/last_qc_run_at\s*=/i);
    expect(s).not.toMatch(/last_patient_result_at\s*=/i);     // the consumer owns that column
    expect(t.q[0]!.values).toEqual(expect.arrayContaining([TENANT_A, PLN(1), at('08:00:00')]));
  });
});

describe('gauge source', () => {
  it('oldestRejectedWithoutActionAt: min evaluated_at of EVALUATED REJECTED runs with NOT EXISTS a corrective action (same tenant), closed runs excluded', async () => {
    const t = tx([{ evaluated_at: at('06:00:00') }]);
    const v = await repo.oldestRejectedWithoutActionAt(t.tx, TENANT_A);
    const s = flat(sql(t));
    expect(s).toMatch(/FROM quality\.qc_runs/i);
    expect(s).toMatch(/status\s*=\s*'evaluated'/i);
    expect(s).toMatch(/outcome\s*=\s*'rejected'/i);
    expect(s).toMatch(/NOT EXISTS\s*\(\s*SELECT[^)]*FROM quality\.qc_corrective_actions[^)]*tenant_id\s*=/i);
    expect(s).toMatch(/min\s*\(\s*(\w+\.)?evaluated_at\s*\)|ORDER BY\s+(\w+\.)?evaluated_at\s+(ASC\s+)?LIMIT\s+1/i);
    expect(v).toBe(at('06:00:00'));
    expect(await repo.oldestRejectedWithoutActionAt(tx([{ evaluated_at: null }]).tx, TENANT_A)).toBeUndefined();
    expect(await repo.oldestRejectedWithoutActionAt(tx([]).tx, TENANT_A)).toBeUndefined();
  });
});
