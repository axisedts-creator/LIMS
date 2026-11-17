// C6-T38 — 02-TRD §14 row "08 Addendum A2" (b): Regenerate (R9) reason `smart_summary_added` with an APPROVED fake summary -> the NEW version carries
// smart_summary_json = the SmartSummary as returned, smart_summary_id = summaryId, smart_summary_version = templateLibraryVersion; a draft summary / omitted
// section / smartreport.* error -> all three NULL (05-SCHEMA §2.3 all-or-none; 02-TRD §4.3 "Reader snapshot", 08 A2.3/A2.8/A4.4). The released v1 is never touched.
// Fakes: SmartReportPort (smartreport.buildSummary); no real DB in this worker harness (the DB CHECK is proven by t38.a2.static.test.ts + db/tests/reporting/C6-T38.a2.test.sql).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TENANT_A } from './consumers.helpers.js';
import { LAB, PORTAL_ORIGIN, build, expectedFingerprint, setup, snapshotOf, versionRow, type Setup } from './assemble.helpers.js';
import { idN } from './assemble.modules.helpers.js';

beforeEach(() => { vi.stubEnv('LIMS_ORIGIN_PORTAL', PORTAL_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });

const readyKeys = ['urine', 'ratio', 'out'] as const;
const released = () => versionRow(1, { status: 'released', released_at: '2026-11-07T10:30:00.000Z', release_basis: 'zero_balance', release_mode: 'auto', audiences: ['patient'], content_fingerprint: expectedFingerprint(readyKeys) });
const regen = (reason_code = 'smart_summary_added') => ({ tenant_id: TENANT_A, report_id: LAB, regeneration: { reason_code } });
const SUMMARY = (status: string, over: Record<string, unknown> = {}) => ({ summaryId: idN(0x5a11), orderId: idN(0x1), reportVersionNo: 2, templateLibraryVersion: 'lib-SYN-2', status,
  panels: [{ code: 'SYN-P', note: 'SYNTH-PANEL' }], deranged: [], advice: [], followUps: [], trends: [], disclaimerBlockId: idN(0x5a12), disclaimerText: 'SYNTH-DISCLAIMER', ...over });
const col = (v: Record<string, unknown>) => (typeof v['smart_summary_json'] === 'string' ? JSON.parse(v['smart_summary_json'] as string) : v['smart_summary_json']);

function world(smart: string | Error, over: Record<string, unknown> = {}): Setup {
  const s = setup({ versions: [released()], reportOver: { regeneration_counter: 1 }, smartFlag: true });
  (s.ports.ports as any).smartreport.buildSummary = async (_c: unknown, i: unknown) => { s.ports.calls.smart.push(i); if (smart instanceof Error) throw smart; return SUMMARY(smart, over); };
  return s;
}
const go = async (s: Setup, payload: unknown = regen()) => { const h = await build(s); await s.run(h, payload); return s.versions(); };
const allNull = (v: Record<string, unknown>) => { expect(v['smart_summary_json'] ?? null).toBeNull(); expect(v['smart_summary_id'] ?? null).toBeNull(); expect(v['smart_summary_version'] ?? null).toBeNull(); };

describe('A2(b) Regenerate reason smart_summary_added -> snapshot on the new version', () => {
  it('approved summary: v2 carries the SmartSummary JSON as returned + summaryId + templateLibraryVersion; buildSummary asked for version 2', async () => {
    const s = world('approved'); const [v1, v2] = await go(s);
    expect(s.versions()).toHaveLength(2);
    expect(s.ports.calls.smart).toEqual([{ orderId: v2!['order_id'], version: 2 }]);
    expect(col(v2!)).toEqual(SUMMARY('approved'));                                  // the whole SmartSummary, nothing dropped or renamed
    expect(v2!['smart_summary_id']).toBe(idN(0x5a11)); expect(v2!['smart_summary_version']).toBe('lib-SYN-2');
    expect(v2).toMatchObject({ regeneration_reason_code: 'smart_summary_added', report_kind: 'final' });
    allNull(v1!);                                                                    // the released v1 is not rewritten (columns immutable after insert)
  });
  it('draft summary at Regenerate -> all three NULL, nothing of the draft stored in the version', async () => {
    const s = world('draft', { disclaimerText: 'SYNTH-DRAFT-ONLY' }); const [, v2] = await go(s);
    allNull(v2!); expect(JSON.stringify(v2)).not.toContain('SYNTH-DRAFT-ONLY'); expect(snapshotOf(v2!).smart).toBeUndefined();
  });
  it.each(['smartreport.feature_disabled', 'smartreport.no_eligible_results', 'smartreport.template_not_approved'])('port throws %s -> version still created, all three NULL', async (code) => {
    const s = world(Object.assign(new Error('x'), { code })); const [, v2] = await go(s);
    expect(s.versions()).toHaveLength(2); allNull(v2!);
  });
  it('tenant feature flag off -> SmartReportPort not called, all three NULL', async () => {
    const s = setup({ versions: [released()], reportOver: { regeneration_counter: 1 } }); await go(s);
    expect(s.ports.calls.smart).toEqual([]); allNull(s.versions()[1]!);
  });
  it('all-or-none holds for every stored combination (the three columns are set together or not at all)', async () => {
    for (const [st, set] of [['approved', true], ['draft', false], ['approved ', false]] as const) {
      const v2 = (await go(world(st)))[1]!; const n = ['smart_summary_json', 'smart_summary_id', 'smart_summary_version'].filter((k) => (v2[k] ?? null) !== null).length;
      expect(n).toBe(set ? 3 : 0);
    }
  });
  it('other reasons also snapshot an approved summary (every version assembled with an approved summary, 08 A4.4)', async () => {
    const s = world('approved'); const [, v2] = await go(s, regen('template_correction'));
    expect(v2!['smart_summary_id']).toBe(idN(0x5a11)); expect(v2!['report_kind']).toBe('amended');
  });
});
