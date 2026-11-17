// C6-T39 — 02-TRD §14 row "08 Addendum A4" (a): FIRST assembly (no Regenerate) with an `approved` fake summary -> the new version carries smart_summary_json /
// smart_summary_id / smart_summary_version (08 A4.4: "at first assembly and at Regenerate alike"); draft summary or smartreport.feature_disabled -> all three NULL.
// The `smartSummaryAvailable` read side (columns non-null) is asserted in services/api .../reportingport.read.test.ts (existing, in verify). Regenerate: C6-T38 assemble_smart_regeneration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAB, PORTAL_ORIGIN, build, setup, snapshotOf, type Setup } from './assemble.helpers.js';
import { idN } from './assemble.modules.helpers.js';

beforeEach(() => { vi.stubEnv('LIMS_ORIGIN_PORTAL', PORTAL_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });

const SUMMARY = (status: string, over: Record<string, unknown> = {}) => ({ summaryId: idN(0x5a21), orderId: idN(0x1), reportVersionNo: 1, templateLibraryVersion: 'lib-SYN-1', status,
  panels: [{ code: 'SYN-P', note: 'SYNTH-PANEL' }], deranged: [], advice: [], followUps: [], trends: [], disclaimerBlockId: idN(0x5a22), disclaimerText: 'SYNTH-DISCLAIMER-A4', ...over });
const col = (v: Record<string, unknown>) => (typeof v['smart_summary_json'] === 'string' ? JSON.parse(v['smart_summary_json'] as string) : v['smart_summary_json']);
const allNull = (v: Record<string, unknown>) => { expect(v['smart_summary_json'] ?? null).toBeNull(); expect(v['smart_summary_id'] ?? null).toBeNull(); expect(v['smart_summary_version'] ?? null).toBeNull(); };

function world(smart: string | Error): Setup {
  const s = setup({ smartFlag: true });
  (s.ports.ports as any).smartreport.buildSummary = async (_c: unknown, i: unknown) => { s.ports.calls.smart.push(i); if (smart instanceof Error) throw smart; return SUMMARY(smart); };
  return s;
}
const first = async (s: Setup) => { const h = await build(s); await s.run(h); return s.versions(); };

describe('A4(a) first assembly snapshots the approved summary (08 A4.4)', () => {
  it('approved: version 1 carries the SmartSummary as returned + summaryId + templateLibraryVersion; buildSummary asked for version 1; no regeneration reason', async () => {
    const s = world('approved'); const vs = await first(s);
    expect(vs).toHaveLength(1); const v = vs[0]!;
    expect(s.ports.calls.smart).toEqual([{ orderId: v['order_id'], version: 1 }]);
    expect(col(v)).toEqual(SUMMARY('approved'));
    expect(v['smart_summary_id']).toBe(idN(0x5a21)); expect(v['smart_summary_version']).toBe('lib-SYN-1');
    expect(v['regeneration_reason_code'] ?? null).toBeNull();
    expect(v).toMatchObject({ report_id: LAB, version_no: 1, report_kind: 'final' });
  });
  it('approved: the frozen content snapshot embeds the smart section from the same summary (the PDF and the portal show one truth)', async () => {
    const s = world('approved'); const [v] = await first(s);
    const smart = (snapshotOf(v!) as any).smart;
    expect(smart).toMatchObject({ summaryId: idN(0x5a21), templateLibraryVersion: 'lib-SYN-1' });
  });
  it('draft summary at first assembly -> all three NULL and nothing of the draft stored anywhere in the version', async () => {
    const s = world('draft'); const [v] = await first(s);
    allNull(v!); expect(JSON.stringify(v)).not.toContain('SYNTH-DISCLAIMER-A4'); expect((snapshotOf(v!) as any).smart).toBeUndefined();
  });
  it('smartreport.feature_disabled at first assembly -> version still created, all three NULL', async () => {
    const s = world(Object.assign(new Error('off'), { code: 'smartreport.feature_disabled' })); const vs = await first(s);
    expect(vs).toHaveLength(1); allNull(vs[0]!);
  });
  it('a non-smartreport error at first assembly is NOT swallowed (no version)', async () => {
    const s = world(Object.assign(new Error('db down'), { code: 'common.unavailable' })); const h = await build(s);
    await expect(s.run(h)).rejects.toBeTruthy(); expect(s.versions()).toHaveLength(0);
  });
  it('tenant feature flag off -> port never called, all three NULL (A4.4 applies only to approved summaries)', async () => {
    const s = setup(); const [v] = await first(s); expect(s.ports.calls.smart).toEqual([]); allNull(v!);
  });
  it('all-or-none: every first-assembly outcome stores 0 or 3 of the columns, never 1-2', async () => {
    for (const [st, n] of [['approved', 3], ['draft', 0], ['rejected', 0], ['pending', 0]] as const) {
      const v = (await first(world(st)))[0]!;
      expect(['smart_summary_json', 'smart_summary_id', 'smart_summary_version'].filter((k) => (v[k] ?? null) !== null).length, st).toBe(n);
    }
  });
});
