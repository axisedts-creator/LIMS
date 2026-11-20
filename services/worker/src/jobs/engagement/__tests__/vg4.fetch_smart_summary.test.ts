// VERIFY-GREEN-4 behaviour pin (fetch_smart_summary.ts, TS18046 x2 on `versionNo` after the Number.isInteger guard): the fix may narrow `versionNo` with a type-only
// cast/guard, so the accepted range 1..9999 (smart_summaries version column) must not move. PASSES now and must pass after. fetch_smart_summary.test.ts already pins
// 0, '1', 1.5 and a foreign tenant; this adds the upper edge, -1, 10000 and a non-finite number. "Accepted" = the task got past validation and read settings (1 query).
import { describe, expect, it } from 'vitest';
import { createFetchSmartSummary } from '../tasks/fetch_smart_summary.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', RPT = '01a1a98a-ac40-7000-8000-0000000000b1';
const run = async (versionNo: unknown) => {
  const queries: string[] = []; const warns: unknown[] = [];
  const tx = { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; } };   // settings row absent -> the task stops with the feature_off no-op
  const ctx: any = { tenantId: TENANT, tx, actor: { type: 'system', id: TENANT }, now: () => '2026-11-16T04:00:00.000Z', ports: {}, log: { info() {}, warn: (e: unknown) => { warns.push(e); }, error() {} } };
  await createFetchSmartSummary()({ tenant_id: TENANT, report_id: RPT, version_no: versionNo } as any, ctx);
  return { queries, warns };
};

describe('fetch_smart_summary version_no range 1..9999 (VERIFY-GREEN-4)', () => {
  it.each([1, 2, 9999])('version_no %s passes validation (settings are read)', async (v) => {
    const r = await run(v); expect(r.queries).toHaveLength(1); expect(r.queries[0]).toMatch(/engagement\.settings/); expect(r.warns).toEqual([]);
  });
  it.each([0, -1, 10000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined])('version_no %s is a silent bad_payload no-op: no query, one warn, no throw', async (v) => {
    const r = await run(v); expect(r.queries).toEqual([]); expect(r.warns).toEqual([{ event: 'fetch_smart_summary_skipped', reason: 'bad_payload' }]);
  });
});
