// C8 AN-T12 — repository/tat.repo.ts: percentile queries over analytics.tat_facts (02-TRD §6.6; PRD US-11.2/5; 07-SECURITY P1, P4, injection). Fake tx records (text, values).
// SEAM (writer may dispute): `tatRows(tx, { tenantId, from, to, scope, segments, priority?, specimenTypeCodes?, processingBranchIds?, groupBy })` with positional params
// $1 tenant, $2 segment array, $3 from, $4 to, $5 all-centres flag, $6 centre-id array (TRD §6.6 verbatim); optional filters take $7.. in any order. Rows come back as
// { segment, key|null, n, median_seconds|null, p90_seconds|null, max_seconds|null, anomalies } with numbers (UNROUNDED percentiles: the mapper rounds half-up, TRD §6.6).
// groupBy: none | centre | processing_branch | priority | specimen_type | day | ad_month (| bs_month: the service may group per B.S.-month sub-range; not pinned here).
import { describe, expect, it } from 'vitest';
import * as tat from '../tat.repo.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const C1 = '22222222-2222-4222-8222-222222222221';
const C2 = '22222222-2222-4222-8222-222222222222';
const BR = '33333333-3333-4333-8333-333333333331';
const ALL = { all: true, centreIds: [] as string[] };
const RESTRICTED = { all: false, centreIds: [C1, C2] };
const EMPTY = { all: false, centreIds: [] as string[] };
const FROM = '2026-11-05', TO = '2026-11-07';
const SEGS = ['pre_analytical', 'transport', 'within_lab', 'total_first_release', 'total_final_release'];

function fakeTx(rows: any[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (values[4] === false && Array.isArray(values[5]) && values[5].length === 0) return { rows: [] }; // the database answers nothing for an empty restricted scope
      return { rows };
    },
  };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const base = { tenantId: TENANT, from: FROM, to: TO, scope: RESTRICTED, segments: SEGS, groupBy: 'none' };
const run = (tx: any, over: Record<string, unknown> = {}) => (tat as any).tatRows(tx, { ...base, ...over });
const groupClause = (sql: string): string => /group by (.*?)(?: order by .*)?$/.exec(sql)?.[1]?.trim() ?? '';

describe('tatRows — SQL shape (TRD §6.6)', () => {
  it('exists and reads analytics.tat_facts with tenant, segment list, [from, to) on business_date and the TRD scope predicate, all as bound parameters', async () => {
    expect(typeof (tat as any).tatRows).toBe('function');
    const tx = fakeTx([]);
    await run(tx);
    expect(tx.calls).toHaveLength(1);
    const { text, values } = tx.calls[0]!;
    const sql = norm(text);
    expect(sql).toContain('from analytics.tat_facts');
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toMatch(/segment = any \(\$2\)/);
    expect(sql).toContain('business_date >= $3');
    expect(sql).toContain('business_date < $4');
    expect(sql).toMatch(/\$5 or \(centre_id is not null and centre_id = any \(\$6\)\)/);
    expect(values.slice(0, 6)).toEqual([TENANT, SEGS, FROM, TO, false, [C1, C2]]);
    expect(sql).not.toContain('select *');
  });

  it('exact percentiles: percentile_cont(0.5) / (0.9) over duration_seconds, max and n over NON-anomalies, anomalies counted separately', async () => {
    const tx = fakeTx([]);
    await run(tx);
    const sql = text0(tx);
    expect(sql).toMatch(/percentile_cont\s*\(\s*0\.5\s*\)\s*within group\s*\(\s*order by duration_seconds\s*\)\s*filter\s*\(\s*where not is_anomaly\s*\)/);
    expect(sql).toMatch(/percentile_cont\s*\(\s*0\.9\s*\)\s*within group\s*\(\s*order by duration_seconds\s*\)\s*filter\s*\(\s*where not is_anomaly\s*\)/);
    expect(sql).toMatch(/max\s*\(\s*duration_seconds\s*\)\s*filter\s*\(\s*where not is_anomaly\s*\)/);
    expect(sql).toMatch(/count\s*\(\s*\*\s*\)\s*filter\s*\(\s*where not is_anomaly\s*\)/);
    expect(sql).toMatch(/count\s*\(\s*\*\s*\)\s*filter\s*\(\s*where is_anomaly\s*\)/);
    expect(sql).not.toMatch(/percentile_disc|\bavg\s*\(|approx|width_bucket/);   // never approximate or average
  });

  it('all-centre scope binds $5 = true and an empty $6; no tenant / date / centre / segment value is interpolated into the text', async () => {
    const tx = fakeTx();
    await run(tx, { scope: ALL });
    expect(tx.calls[0]!.values.slice(0, 6)).toEqual([TENANT, SEGS, FROM, TO, true, []]);
    await run(tx, { scope: RESTRICTED });
    for (const call of tx.calls) for (const v of [TENANT, FROM, TO, C1, C2, 'within_lab', 'pre_analytical']) expect(call.text).not.toContain(v);
  });

  it('empty restricted scope → no rows (never widens to all centres)', async () => {
    expect(await run(fakeTx([{ segment: 'pre_analytical', key: null, n: '1', median_seconds: 1, p90_seconds: 1, max_seconds: '1', anomalies: '0' }]), { scope: EMPTY })).toEqual([]);
  });

  it('missing / malformed scope throws before any query (scope is mandatory)', async () => {
    const tx = fakeTx();
    await expect(run(tx, { scope: undefined })).rejects.toThrow(/scope/i);
    await expect(run(tx, { scope: { all: 'yes', centreIds: [] } })).rejects.toThrow(/scope/i);
    expect(tx.calls).toEqual([]);
  });
});
const text0 = (tx: { calls: { text: string }[] }) => norm(tx.calls[0]!.text);

describe('tatRows — optional filters are bound parameters, absent when not asked (TRD §6.6 [AND …])', () => {
  it('no filter → no priority / specimen_type_code / processing_branch_id predicate in the text, exactly six bound values', async () => {
    const tx = fakeTx();
    await run(tx);
    expect(text0(tx)).not.toMatch(/priority|specimen_type_code|processing_branch_id/); // ungrouped: those columns are not even selected
    expect(tx.calls[0]!.values).toHaveLength(6);
  });

  it('priority / specimen_type_code / processing_branch_id are bound after $6, never interpolated', async () => {
    const tx = fakeTx();
    await run(tx, { priority: 'urgent', specimenTypeCodes: ['serum', 'edta'], processingBranchIds: [BR] });
    const { text, values } = tx.calls[0]!;
    const sql = norm(text);
    expect(sql).toMatch(/priority = \$\d+/);
    expect(sql).toMatch(/specimen_type_code = any \(\$\d+\)/);
    expect(sql).toMatch(/processing_branch_id = any \(\$\d+\)/);
    expect(values.slice(6)).toEqual(expect.arrayContaining(['urgent', ['serum', 'edta'], [BR]]));
    for (const v of ['urgent', 'serum', 'edta', BR]) expect(text).not.toContain(v);
  });

  it('only the filters given are applied (priority alone adds exactly one value)', async () => {
    const tx = fakeTx();
    await run(tx, { priority: 'routine' });
    expect(tx.calls[0]!.values).toHaveLength(7);
    expect(text0(tx)).not.toMatch(/specimen_type_code = any|processing_branch_id = any/);
  });

  it('a hostile specimen type code is still just a bound value', async () => {
    const tx = fakeTx();
    const evil = "x'); DROP TABLE analytics.tat_facts; --";
    await run(tx, { specimenTypeCodes: [evil] });
    expect(tx.calls[0]!.text).not.toContain('DROP');
    expect(tx.calls[0]!.values).toContainEqual([evil]);
  });

  it('priority outside routine|urgent or a segment outside the five throws before querying', async () => {
    for (const over of [{ priority: 'high' }, { priority: "urgent' OR 1=1" }, { segments: ['within_lab', 'bogus'] }, { segments: ['x; DROP TABLE y'] }]) {
      const tx = fakeTx();
      await expect(run(tx, over), JSON.stringify(over)).rejects.toThrow();
      expect(tx.calls).toEqual([]);
    }
  });
});

describe('tatRows — group keys come only from a closed allow-list (07 injection, abuse case 1)', () => {
  it.each([
    ['none', 'segment'], ['centre', /centre_id/], ['processing_branch', /processing_branch_id/], ['priority', /priority/],
    ['specimen_type', /specimen_type_code/], ['day', /business_date/], ['ad_month', /business_date/],
  ] as const)('groupBy %s → GROUP BY segment (+ its own column) and an ORDER BY', async (groupBy, col) => {
    const tx = fakeTx();
    await run(tx, { groupBy });
    const sql = text0(tx);
    const g = groupClause(sql);
    expect(g, sql).toMatch(/\bsegment\b/);
    if (typeof col === 'string') expect(g.replace(/[\s;]/g, '')).toBe('segment'); else expect(g).toMatch(col);
    expect(sql).toMatch(/order by/);
  });

  it('anything else throws before querying', async () => {
    for (const groupBy of ["day'; DROP TABLE analytics.tat_facts; --", '', 'centre_id, tenant_id', 'subject_id', undefined, 7]) {
      const tx = fakeTx();
      await expect(run(tx, { groupBy }), String(groupBy)).rejects.toThrow();
      expect(tx.calls).toEqual([]);
    }
  });
});

describe('tatRows — result mapping', () => {
  const ROW = { segment: 'within_lab', key: null, n: '4', median_seconds: '2400.5', p90_seconds: 5940.000000000001, max_seconds: '7200', anomalies: '1' };

  it('bigint strings become numbers; percentiles are NOT rounded here (the mapper rounds half-up)', async () => {
    const out = await run(fakeTx([ROW]), { scope: ALL });
    expect(out).toEqual([{ segment: 'within_lab', key: null, n: 4, median_seconds: 2400.5, p90_seconds: 5940.000000000001, max_seconds: 7200, anomalies: 1 }]);
  });

  it('a group of only anomalies (n 0, NULL stats) keeps null stats, never 0', async () => {
    const out = await run(fakeTx([{ segment: 'pre_analytical', key: null, n: '0', median_seconds: null, p90_seconds: null, max_seconds: null, anomalies: '2' }]), { scope: ALL });
    expect(out).toHaveLength(1);
    expect(out[0].n).toBe(0);
    expect(out[0].anomalies).toBe(2);
    for (const k of ['median_seconds', 'p90_seconds', 'max_seconds']) expect(out[0][k] ?? null, k).toBeNull();
  });

  it('group keys pass through as returned (uuid, code, date)', async () => {
    const out = await run(fakeTx([{ ...ROW, key: C1 }, { ...ROW, key: '2026-11-05' }]), { scope: ALL, groupBy: 'day' });
    expect(out.map((r: any) => r.key)).toEqual([C1, '2026-11-05']);
  });

  it('a count beyond 2^53 is refused, never rounded', async () => {
    await expect(run(fakeTx([{ ...ROW, n: '9007199254740993' }]), { scope: ALL })).rejects.toThrow();
    await expect(run(fakeTx([{ ...ROW, anomalies: '9007199254740993' }]), { scope: ALL })).rejects.toThrow();
  });
});
