// C9 T-13 — SQL hygiene + shape of repository/status.repo.ts (02-TRD §7.8 query note, §5.5 #34, 05-SCHEMA indexes qc_runs__tenant_plan_runat__idx / qc_runs__tenant_plan_open_rejected__p_idx;
// 07-SECURITY REQ-SEC-022/024/082). No database: a recording tx. Seam: status.helpers.ts header. Fails now: "Cannot find module ../repository/status.repo.js".
import { describe, expect, it } from 'vitest';
import { createStatusRepo } from '../repository/status.repo.js';
import { ANA, INS, PLN, TENANT_A as TN } from './status.helpers.js';

const AT = '2026-11-05T04:15:00.000Z';
function rec(rows: any[] = []) {
  const q: Array<{ text: string; values: unknown[] }> = [];
  const tx = { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows, rowCount: rows.length }; } };
  return { tx, q };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const repo = createStatusRepo();
async function everyStatement() {
  const { tx, q } = rec([]);
  await repo.findPlanForPair(tx, TN, INS(1), ANA(1));
  await repo.listRunsForStatus(tx, TN, [PLN(1), PLN(2)], AT);
  await repo.listBoardPlans(tx, TN);
  await repo.listActivity(tx, TN, [PLN(1), PLN(2)]);
  await repo.listInstrumentLabels(tx, TN, [INS(1), INS(2)]);
  return q.map((x) => ({ ...x, text: norm(x.text) }));
}

describe('status.repo: every statement', () => {
  it('there are exactly five statements, one per method (no N+1 inside a method)', async () => { expect(await everyStatement()).toHaveLength(5); });
  it('is parameterised: no id, tenant or timestamp is interpolated into the SQL text', async () => {
    for (const s of await everyStatement()) for (const lit of [TN, PLN(1), PLN(2), INS(1), INS(2), ANA(1), AT]) expect(s.text, s.text).not.toContain(lit);
  });
  it('carries an explicit tenant_id = $n predicate on top of RLS, with the tenant bound as a value', async () => {
    for (const s of await everyStatement()) { expect(s.text, s.text).toMatch(/tenant_id\s*=\s*\$\d/); expect(s.values, s.text).toContain(TN); }
  });
  it('is read-only: SELECT (or WITH ... SELECT) only; never INSERT / UPDATE / DELETE / lock (qcStatusFor is "No writes", §7.8; the port must not block C5 saves)', async () => {
    for (const s of await everyStatement()) {
      expect(s.text, s.text).toMatch(/^(SELECT|WITH)\b/i);
      expect(s.text, s.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b|FOR\s+(UPDATE|SHARE)|pg_advisory/i);
    }
  });
  it('reads quality.* only, plus the C7 directory view for labels (CR-C9-006); never lab.*, never another module\'s base table', async () => {
    for (const s of await everyStatement()) {
      for (const m of s.text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\.([a-z_]+)/gi)) {
        const obj = `${m[1]}.${m[2]}`.toLowerCase();
        expect(obj === 'instruments.v_pub_instrument_directory' || obj.startsWith('quality.'), `${obj} in ${s.text}`).toBe(true);
      }
      expect(s.text, s.text).not.toMatch(/\blab\./i);
    }
  });
  it('does not select sensitive or internal columns (no rule_detail, no internal_note, no created_by, no SELECT *)', async () => {
    for (const s of await everyStatement()) expect(s.text, s.text).not.toMatch(/\bSELECT\s+\*|\.\*|rule_detail|internal_note|created_by|sample_barcode/i);
  });
});

describe('status.repo.findPlanForPair', () => {
  it('plan by (tenant, instrument, analyte) in ANY status + the validity of its current version; row -> { plan_id, qc_validity_hours }, none -> undefined', async () => {
    const a = rec([{ plan_id: PLN(1), qc_validity_hours: 24 }]);
    expect(await repo.findPlanForPair(a.tx, TN, INS(1), ANA(1))).toEqual({ plan_id: PLN(1), qc_validity_hours: 24 });
    const s = norm(a.q[0]!.text);
    expect(s).toMatch(/FROM quality\.qc_plans\b/); expect(s).toMatch(/qc_plan_versions\b/); expect(s).toMatch(/qc_validity_hours/);
    expect(s).toMatch(/instrument_id\s*=\s*\$\d/); expect(s).toMatch(/analyte_id\s*=\s*\$\d/); expect(s).not.toMatch(/'active'/);   // step 1: "any status"
    expect(a.q[0]!.values).toEqual(expect.arrayContaining([TN, INS(1), ANA(1)]));
    expect(await repo.findPlanForPair(rec([]).tx, TN, INS(1), ANA(1))).toBeUndefined();
  });
});

describe('status.repo.listRunsForStatus (§7.8 steps 2-3 query note)', () => {
  it('runs of the given plans (ids bound as ONE array value, = ANY), status evaluated|closed, run_at <= $at, newest first, at most 20 per plan', async () => {
    const a = rec(); await repo.listRunsForStatus(a.tx, TN, [PLN(1), PLN(2)], AT);
    const s = norm(a.q[0]!.text);
    expect(s).toMatch(/FROM quality\.qc_runs\b/); expect(s).toMatch(/plan_id\s*=\s*ANY\(\$\d+(::uuid\[\])?\)/);
    expect(s).toMatch(/status\s+IN\s*\(\s*'evaluated'\s*,\s*'closed'\s*\)/); expect(s).toMatch(/run_at\s*<=\s*\$\d+(::timestamptz)?/); expect(s).toMatch(/ORDER BY[^;]*run_at DESC/i);
    expect(s.includes('20') || a.q[0]!.values.includes(20), 'a per-plan bound of 20 rows').toBe(true);
    expect(a.q[0]!.values).toEqual(expect.arrayContaining([TN, AT])); expect(a.q[0]!.values.some((v) => Array.isArray(v) && v.length === 2 && v.includes(PLN(1)))).toBe(true);
  });
  it('also returns every open rejected run (outcome rejected and closed_at IS NULL or > $at) so an old open rejection cannot fall out of the window', async () => {
    const a = rec(); await repo.listRunsForStatus(a.tx, TN, [PLN(1)], AT); const s = norm(a.q[0]!.text);
    expect(s).toMatch(/outcome\s*=\s*'rejected'/); expect(s).toMatch(/closed_at\s+IS\s+NULL/i); expect(s).toMatch(/closed_at\s*>\s*\$\d+(::timestamptz)?/);
  });
  it('timestamps leave as ISO text with ms (to_char ... UTC), rules_violated as text[]; an empty plan list is answered [] WITHOUT a query', async () => {
    const a = rec(); await repo.listRunsForStatus(a.tx, TN, [PLN(1)], AT); const s = norm(a.q[0]!.text);
    expect(s).toMatch(/to_char\([^)]*run_at[^)]*AT TIME ZONE 'UTC'/i); expect(s).toMatch(/to_char\([^)]*closed_at[^)]*AT TIME ZONE 'UTC'/i); expect(s).toMatch(/rules_violated/);
    const e = rec(); expect(await repo.listRunsForStatus(e.tx, TN, [], AT)).toEqual([]); expect(e.q).toEqual([]);
  });
  it('rows pass through untouched in shape: { plan_id, id, status, outcome, run_at, closed_at, rules_violated }', async () => {
    const row = { plan_id: PLN(1), id: 'r1', status: 'evaluated', outcome: 'accepted', run_at: AT, closed_at: null, rules_violated: [] };
    expect(await repo.listRunsForStatus(rec([row]).tx, TN, [PLN(1)], AT)).toEqual([row]);
  });
});

describe('status.repo board reads', () => {
  it('listBoardPlans: ACTIVE plans of the tenant with test_id and the current version\'s validity; deterministic order (instrument_id, analyte_id, plan_id); no analyte code in SQL (CatalogPort.getTest is its source, T-13 ruling)', async () => {
    const a = rec(); await repo.listBoardPlans(a.tx, TN); const s = norm(a.q[0]!.text);
    expect(s).toMatch(/FROM quality\.qc_plans\b/); expect(s).toMatch(/status\s*=\s*'active'/); expect(s).toMatch(/qc_validity_hours/); expect(s).toMatch(/test_id/);
    expect(s).toMatch(/ORDER BY[^;]*instrument_id[^;]*analyte_id[^;]*(\.|\s)id\b/i);
  });
  it('listActivity: quality.qc_activity of the given plan ids (one array value), timestamps as ISO text; empty list -> [] without a query', async () => {
    const a = rec(); await repo.listActivity(a.tx, TN, [PLN(1)]); const s = norm(a.q[0]!.text);
    expect(s).toMatch(/FROM quality\.qc_activity\b/); expect(s).toMatch(/plan_id\s*=\s*ANY\(\$\d+(::uuid\[\])?\)/); expect(s).toMatch(/patient_results_since_last_qc/); expect(s).toMatch(/to_char\([^)]*last_qc_run_at/i);
    const e = rec(); expect(await repo.listActivity(e.tx, TN, [])).toEqual([]); expect(e.q).toEqual([]);
  });
  it('listInstrumentLabels: only instruments.v_pub_instrument_directory (CR-C9-006) with tenant_id, instrument_id = ANY($n), the columns instrument_code + display_name; empty list -> [] without a query', async () => {
    const a = rec(); await repo.listInstrumentLabels(a.tx, TN, [INS(1)]); const s = norm(a.q[0]!.text);
    expect(s).toMatch(/FROM instruments\.v_pub_instrument_directory\b/); expect(s).toMatch(/instrument_id\s*=\s*ANY\(\$\d+(::uuid\[\])?\)/); expect(s).toMatch(/instrument_code/); expect(s).toMatch(/display_name/);
    expect(s).not.toMatch(/\bvendor\b|\bmodel\b|\bcentre_id\b/);
    const e = rec(); expect(await repo.listInstrumentLabels(e.tx, TN, [])).toEqual([]); expect(e.q).toEqual([]);
  });
  it('Postgres errors pass through unchanged (the service maps them to common.internal)', async () => {
    const boom = Object.assign(new Error('pg down'), { code: '57P01' });
    const tx = { async query() { throw boom; } };
    await expect(repo.findPlanForPair(tx, TN, INS(1), ANA(1))).rejects.toBe(boom);
    await expect(repo.listBoardPlans(tx, TN)).rejects.toBe(boom);
  });
});
