// C9 T-14 — SQL hygiene + shape of repository/chart.repo.ts (02-TRD §7.10, §5.5 #35, 05-SCHEMA index qc_observations__tenant_plan_observed__idx / qc_targets__tenant_plan_lot_from__idx;
// 07-SECURITY REQ-SEC-022/024/081/100, AB-08). No database: a recording tx. Seam: chart.helpers.ts header. Fails now: "Cannot find module ../repository/chart.repo.js".
import { describe, expect, it } from 'vitest';
import { createChartRepo } from '../repository/chart.repo.js';
import { FROM, LOT, LVL, PLN, RUN, TENANT_A as TN, TO } from './chart.helpers.js';

function rec(rows: any[] = []) {
  const q: Array<{ text: string; values: unknown[] }> = [];
  const tx = { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows, rowCount: rows.length }; } };
  return { tx, q };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const repo = createChartRepo();
async function everyStatement() {
  const { tx, q } = rec([]);
  await repo.findPlan(tx, TN, PLN(1));
  await repo.listChartObservations(tx, TN, { planId: PLN(1), levelId: LVL(1), lotId: LOT(1), from: FROM, to: TO, limit: 2001 });
  await repo.listChartObservations(tx, TN, { planId: PLN(1), from: FROM, to: TO, limit: 2001 });
  await repo.listRunsForChart(tx, TN, [RUN(1), RUN(2)]);
  await repo.listTargetsForChart(tx, TN, { planId: PLN(1), lotIds: [LOT(1), LOT(2)], from: FROM, to: TO });
  return q.map((x) => ({ ...x, text: norm(x.text) }));
}

describe('chart.repo: every statement', () => {
  it('one statement per call (no N+1 inside a method)', async () => { expect(await everyStatement()).toHaveLength(5); });
  it('is parameterised: no id, tenant or timestamp is interpolated into the SQL text', async () => {
    for (const s of await everyStatement()) for (const lit of [TN, PLN(1), LVL(1), LOT(1), LOT(2), RUN(1), RUN(2), FROM, TO]) expect(s.text, s.text).not.toContain(lit);
  });
  it('carries an explicit tenant_id = $n predicate on top of RLS, the tenant bound as a value (REQ-SEC-024)', async () => {
    for (const s of await everyStatement()) { expect(s.text, s.text).toMatch(/tenant_id\s*=\s*\$\d/); expect(s.values, s.text).toContain(TN); }
  });
  it('is read-only: SELECT (or WITH ... SELECT) only; no write, no lock, no advisory lock', async () => {
    for (const s of await everyStatement()) {
      expect(s.text, s.text).toMatch(/^(SELECT|WITH)\b/i);
      expect(s.text, s.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b|FOR\s+(UPDATE|SHARE)|pg_advisory/i);
    }
  });
  it('reads quality.* only: never lab.* (the sync owns that), instruments.*, catalog.* (analyte data comes through CatalogPort)', async () => {
    for (const s of await everyStatement()) {
      for (const m of s.text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\.([a-z_]+)/gi)) expect(`${m[1]}.${m[2]}`.toLowerCase().startsWith('quality.'), `${m[1]}.${m[2]} in ${s.text}`).toBe(true);
      expect(s.text, s.text).not.toMatch(/\b(lab|instruments|catalog)\./i);
    }
  });
  it('no SELECT *, no internal / personal columns (created_by, updated_by, excluded_*, *_comment, note, retire_reason, basis_*, control_id_raw, version)', async () => {
    for (const s of await everyStatement()) expect(s.text, s.text).not.toMatch(/\bSELECT\s+\*|\.\*|created_by|updated_by|excluded_by|excluded_comment|excluded_at|retire_reason|\bnote\b|basis_|control_id_raw|control_lot_raw|\bversion\b/i);
  });
});

describe('chart.repo.findPlan', () => {
  it('plan by (tenant, id) in ANY status -> { plan_id, instrument_id, analyte_id, test_id }; none -> undefined', async () => {
    const a = rec([{ plan_id: PLN(1), instrument_id: 'I', analyte_id: 'A', test_id: 'T' }]);
    expect(await repo.findPlan(a.tx, TN, PLN(1))).toEqual({ plan_id: PLN(1), instrument_id: 'I', analyte_id: 'A', test_id: 'T' });
    const s = norm(a.q[0]!.text); expect(s).toMatch(/FROM quality\.qc_plans\b/); expect(s).toMatch(/\bid\s*=\s*\$\d/); expect(s).not.toMatch(/'active'/); expect(s).toMatch(/test_id/);
    expect(a.q[0]!.values).toEqual(expect.arrayContaining([TN, PLN(1)]));
    expect(await repo.findPlan(rec([]).tx, TN, PLN(1))).toBeUndefined();
  });
});

describe('chart.repo.listChartObservations', () => {
  const run = async (o: object = {}) => { const r = rec([]); await repo.listChartObservations(r.tx, TN, { planId: PLN(1), from: FROM, to: TO, limit: 2001, ...o }); return { s: norm(r.q[0]!.text), v: r.q[0]!.values }; };
  it('quality.qc_observations joined to control_levels / control_lots on (tenant_id, id) for level_code and lot_no', async () => {
    const { s } = await run();
    expect(s).toMatch(/FROM quality\.qc_observations\b/); expect(s).toMatch(/JOIN quality\.control_levels\b[^;]*tenant_id\s*=[^;]*tenant_id/i); expect(s).toMatch(/JOIN quality\.control_lots\b[^;]*tenant_id\s*=[^;]*tenant_id/i);
    expect(s).toMatch(/level_code/); expect(s).toMatch(/lot_no/);
  });
  it('selects exactly the chart columns: id, level_id/code, lot_id/no, observed_at (ISO ms), value::text, z::text, status, qc_run_id', async () => {
    const { s } = await run();
    for (const c of ['level_id', 'level_code', 'lot_id', 'lot_no', 'status', 'qc_run_id']) expect(s, c).toContain(c);
    expect(s).toMatch(/\.?value::text/); expect(s).toMatch(/\.?z::text/); expect(s).toMatch(/to_char\([^)]*observed_at[^)]*AT TIME ZONE 'UTC'/i); expect(s).toMatch(/\.MS"Z"/);
  });
  it('predicates: plan_id, observed_at >= from AND <= to (both inclusive, bound), level_id / lot_id / value NOT NULL (a point needs a series and a number)', async () => {
    const { s, v } = await run();
    expect(s).toMatch(/plan_id\s*=\s*\$\d/); expect(s).toMatch(/observed_at\s*>=\s*\$\d+(::timestamptz)?/); expect(s).toMatch(/observed_at\s*<=\s*\$\d+(::timestamptz)?/);
    expect(s).toMatch(/level_id\s+IS\s+NOT\s+NULL/i); expect(s).toMatch(/lot_id\s+IS\s+NOT\s+NULL/i); expect(s).toMatch(/\bvalue\s+IS\s+NOT\s+NULL/i);
    expect(v).toEqual(expect.arrayContaining([TN, PLN(1), FROM, TO]));
  });
  it('newest first with a bound LIMIT: ORDER BY observed_at DESC, id DESC and the limit is a parameter value, not text (AB-08 cap)', async () => {
    const { s, v } = await run({ limit: 2001 });
    expect(s).toMatch(/ORDER BY\s+[a-z_.]*observed_at\s+DESC\s*,\s*[a-z_.]*\bid\s+DESC/i); expect(s).toMatch(/LIMIT\s+\$\d+/i); expect(v).toContain(2001); expect(s).not.toMatch(/LIMIT\s+\d/i);
  });
  it('level / lot filters are bound values only when given (never concatenated); absent -> no value for them', async () => {
    const a = await run({ levelId: LVL(1), lotId: LOT(1) }); expect(a.v).toEqual(expect.arrayContaining([LVL(1), LOT(1)])); expect(a.s).toMatch(/level_id\s*=\s*\$\d/); expect(a.s).toMatch(/lot_id\s*=\s*\$\d/);
    const b = await run(); expect(b.v).not.toContain(LVL(1)); expect(b.v).not.toContain(LOT(1));
  });
  it('rows pass through (the service shapes them)', async () => {
    const rows = [{ id: 'o1', level_id: 'l', level_code: 'L1', lot_id: 'x', lot_no: 'N', observed_at: '2026-10-10T08:00:00.000Z', value: '1.0', z: null, status: 'assigned', qc_run_id: null }];
    expect(await repo.listChartObservations(rec(rows).tx, TN, { planId: PLN(1), from: FROM, to: TO, limit: 10 })).toEqual(rows);
  });
});

describe('chart.repo.listRunsForChart', () => {
  it('quality.qc_runs by (tenant, id = ANY(array)): id, status, outcome, rule_detail only; an empty id list is answered [] WITHOUT a query', async () => {
    const a = rec([]); expect(await repo.listRunsForChart(a.tx, TN, [])).toEqual([]); expect(a.q).toHaveLength(0);
    const b = rec([{ id: RUN(1), status: 'evaluated', outcome: 'rejected', rule_detail: [{ rule: '1-3s', observation_ids: ['o'] }] }]);
    expect(await repo.listRunsForChart(b.tx, TN, [RUN(1), RUN(2)])).toEqual([{ id: RUN(1), status: 'evaluated', outcome: 'rejected', rule_detail: [{ rule: '1-3s', observation_ids: ['o'] }] }]);
    const s = norm(b.q[0]!.text); expect(s).toMatch(/FROM quality\.qc_runs\b/); expect(s).toMatch(/\bid\s*=\s*ANY\(\$\d+(::uuid\[\])?\)/); expect(s).toMatch(/rule_detail/); expect(s).toMatch(/outcome/);
    expect(b.q[0]!.values).toEqual(expect.arrayContaining([TN, [RUN(1), RUN(2)]])); expect(s).not.toMatch(/corrective|review|rejection_event_id|evaluated_by|hold_since/i);
  });
});

describe('chart.repo.listTargetsForChart', () => {
  const run = async (o: object = {}) => { const r = rec([]); await repo.listTargetsForChart(r.tx, TN, { planId: PLN(1), lotIds: [LOT(1)], from: FROM, to: TO, ...o }); return { r, s: r.q[0] ? norm(r.q[0].text) : '', v: r.q[0]?.values ?? [] }; };
  it('quality.qc_targets of the plan and the given lots (one array value); an empty lot list is answered [] WITHOUT a query', async () => {
    const e = await run({ lotIds: [] }); expect(e.r.q).toHaveLength(0);
    const { s, v } = await run({ lotIds: [LOT(1), LOT(2)] });
    expect(s).toMatch(/FROM quality\.qc_targets\b/); expect(s).toMatch(/plan_id\s*=\s*\$\d/); expect(s).toMatch(/lot_id\s*=\s*ANY\(\$\d+(::uuid\[\])?\)/); expect(v).toEqual(expect.arrayContaining([TN, PLN(1), [LOT(1), LOT(2)]]));
  });
  it("only segments that were ever in force: status IN ('active','superseded','retired') — never draft or discarded", async () => {
    const { s } = await run(); expect(s).toMatch(/status\s+IN\s*\(\s*'active'\s*,\s*'superseded'\s*,\s*'retired'\s*\)/); expect(s).not.toMatch(/'draft'|'discarded'/);
  });
  it('overlaps the period: effective_from <= to AND (effective_to IS NULL OR effective_to > from), both bound', async () => {
    const { s, v } = await run();
    expect(s).toMatch(/effective_from\s*<=\s*\$\d+(::timestamptz)?/); expect(s).toMatch(/effective_to\s+IS\s+NULL/i); expect(s).toMatch(/effective_to\s*>\s*\$\d+(::timestamptz)?/); expect(v).toEqual(expect.arrayContaining([FROM, TO]));
  });
  it('selects id, level_id, lot_id, mean::text, sd::text, source, effective_from / effective_to as ISO ms text; no unit, no basis, no note', async () => {
    const { s } = await run();
    for (const c of ['level_id', 'lot_id', 'source', 'effective_from', 'effective_to']) expect(s, c).toContain(c);
    expect(s).toMatch(/mean::text/); expect(s).toMatch(/sd::text/); expect(s).toMatch(/to_char\([^)]*effective_from[^)]*AT TIME ZONE 'UTC'/i); expect(s).toMatch(/to_char\([^)]*effective_to[^)]*AT TIME ZONE 'UTC'/i); expect(s).toMatch(/ORDER BY[^;]*effective_from/i);
  });
});
