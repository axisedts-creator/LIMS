// C6-T44 (tester) — assembly half of the "Final sweep second touch": 02-TRD §14 row "Final sweep" (a) D-61 and (b) P-44; 01-PRD AC-02.8; 02-TRD §4.3 smart section, §4.5 rules 1/3.
//  (a) 08 A17 D-61: released v1 `preliminary`; C5 approves a new micro preliminary with reason `module_preliminary_update` -> v2 report_kind `preliminary`, "Preliminary", no amendment box.
//      The same fixture with `module_phase_progression` + phase final -> `final`; any other C5 reason -> `amended`.
//  (b) 08 A19 P-44: buildSummary runs inside a SAVEPOINT; the fake writes a marker row then fails with smartreport.feature_disabled -> the version is committed without the smart
//      section and the marker write is rolled back first. The same for Regenerate (reason smart_summary_added), which runs through the same task.
// Same fixtures/fake DB as assemble_modules.test.ts and assemble_regeneration.test.ts (no helper edits).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TENANT_A } from './consumers.helpers.js';
import { HASH_2, LAB, PORTAL_ORIGIN, build, expectedFingerprint, setup, snapshotOf, versionRow, type Setup } from './assemble.helpers.js';
import { moduleSetup } from './assemble.modules.helpers.js';

beforeEach(() => { vi.stubEnv('LIMS_ORIGIN_PORTAL', PORTAL_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });

const go = async (s: Setup, payload?: unknown) => { const h = await build(s); await s.run(h, payload as any); return s.versions(); };
const releasedPrelim = () => versionRow(1, { status: 'released', released_at: '2026-11-07T08:00:00.000Z', report_kind: 'preliminary', release_basis: 'zero_balance', release_mode: 'auto', audiences: ['patient'] });

describe('D-61 version kind over a released preliminary (rules 1 and 3; AC-02.8)', () => {
  it('micro preliminary + module_preliminary_update -> v2 preliminary, label "Preliminary", NO amendment box; v1 stays released', async () => {
    const s = moduleSetup({ anatomic: false, microPhase: 'preliminary', microAmend: 'module_preliminary_update', world: { versions: [releasedPrelim()], hash: HASH_2 } });
    const vs = await go(s);
    expect(vs).toHaveLength(2); expect(vs[0]).toMatchObject({ version_no: 1, status: 'released' });
    expect(vs[1]).toMatchObject({ version_no: 2, report_kind: 'preliminary' });
    expect(snapshotOf(vs[1]!)).toMatchObject({ reportKind: 'preliminary', statusLabel: 'Preliminary', amendmentNotes: [] });
  });
  it('micro final + module_phase_progression -> final (not amended)', async () => {
    const s = moduleSetup({ anatomic: false, microPhase: 'final', microAmend: 'module_phase_progression', world: { versions: [releasedPrelim()], hash: HASH_2 } });
    const vs = await go(s);
    expect(vs[1]).toMatchObject({ version_no: 2, report_kind: 'final' }); expect(snapshotOf(vs[1]!)).toMatchObject({ statusLabel: 'Final', amendmentNotes: [] });
  });
  it.each(['corrected_value', 'wrong_patient_sample'])('micro preliminary + any other C5 reason (%s) -> amended, the box names the reason', async (reason) => {
    const s = moduleSetup({ anatomic: false, microPhase: 'preliminary', microAmend: reason, world: { versions: [releasedPrelim()], hash: HASH_2 } });
    const vs = await go(s);
    expect(vs[1]).toMatchObject({ version_no: 2, report_kind: 'amended' });
    expect((snapshotOf(vs[1]!).amendmentNotes as any[]).some((n) => n.reasonCode === reason)).toBe(true);
  });
  it('module_preliminary_update with NO earlier release is still just a preliminary (no amendment box)', async () => {
    const s = moduleSetup({ anatomic: false, microPhase: 'preliminary', microAmend: 'module_preliminary_update' });
    const vs = await go(s);
    expect(vs).toHaveLength(1); expect(vs[0]).toMatchObject({ report_kind: 'preliminary' }); expect(snapshotOf(vs[0]!).amendmentNotes).toEqual([]);
  });
});

describe('P-44 savepoint around SmartReportPort.buildSummary — first assembly and Regenerate', () => {
  const MARK = 'smart_port_write_marker_t44';
  const failAfterWrite = (s: Setup, code: string) => {
    (s.ports.ports as any).smartreport.buildSummary = async (c: any, i: unknown) => {
      s.ports.calls.smart.push(i);
      await c.tx.query('SELECT id FROM reporting.reports WHERE tenant_id = $1 AND id = $2', [TENANT_A, LAB, MARK]);   // stands in for the port's marker write
      throw Object.assign(new Error('synthetic'), { code });
    };
  };
  const at = (s: Setup, re: RegExp) => s.db.stmts.findIndex((x) => re.test(x.text));
  const markAt = (s: Setup) => s.db.stmts.findIndex((x) => x.values.includes(MARK));
  const expectSavepointed = (s: Setup) => {
    const sp = at(s, /^savepoint\b/i); const m = markAt(s); const rb = at(s, /^rollback to savepoint\b/i); const ins = at(s, /^insert into reporting\.report_versions\b/i);
    expect(sp).toBeGreaterThanOrEqual(0); expect(m).toBeGreaterThan(sp); expect(rb).toBeGreaterThan(m); expect(ins).toBeGreaterThan(rb);   // marker rolled back BEFORE the commit path writes
  };

  it('first assembly: marker written then smartreport.feature_disabled -> SAVEPOINT / marker / ROLLBACK TO / INSERT version; version has no smart section', async () => {
    const s = setup({ smartFlag: true }); failAfterWrite(s, 'smartreport.feature_disabled'); const vs = await go(s);
    expectSavepointed(s); expect(vs).toHaveLength(1);
    expect(vs[0]!['smart_summary_json'] ?? null).toBeNull(); expect(vs[0]!['smart_summary_id'] ?? null).toBeNull(); expect(vs[0]!['smart_summary_version'] ?? null).toBeNull();
    expect(snapshotOf(vs[0]!).smart).toBeUndefined();
  });
  it.each(['smartreport.no_eligible_results', 'smartreport.template_not_approved'])('first assembly: %s is caught after the rollback, section omitted, version committed (TRD §7.2 ports table)', async (code) => {
    const s = setup({ smartFlag: true }); failAfterWrite(s, code); const vs = await go(s);
    expectSavepointed(s); expect(vs).toHaveLength(1); expect(snapshotOf(vs[0]!).smart).toBeUndefined();
  });
  it('Regenerate (smart_summary_added) over a released version: same savepoint contract; v2 is created, kind from rules 1-4 (final), smart columns NULL', async () => {
    const released = versionRow(1, { status: 'released', released_at: '2026-11-07T10:30:00.000Z', release_basis: 'zero_balance', release_mode: 'auto', audiences: ['patient'], content_fingerprint: expectedFingerprint(['urine', 'ratio', 'out']) });
    const s = setup({ smartFlag: true, versions: [released], reportOver: { regeneration_counter: 1 } }); failAfterWrite(s, 'smartreport.feature_disabled');
    const vs = await go(s, { tenant_id: TENANT_A, report_id: LAB, regeneration: { reason_code: 'smart_summary_added' } });
    expectSavepointed(s);
    expect(vs).toHaveLength(2); expect(vs[1]).toMatchObject({ version_no: 2, report_kind: 'final', regeneration_reason_code: 'smart_summary_added' });
    expect(vs[1]!['smart_summary_json'] ?? null).toBeNull(); expect(vs[1]!['smart_summary_id'] ?? null).toBeNull(); expect(snapshotOf(vs[1]!).smart).toBeUndefined();
  });
  it('a smartreport.* failure leaves nothing of the port in the committed writes: no write between the marker and the ROLLBACK TO that survives it', async () => {
    const s = setup({ smartFlag: true }); failAfterWrite(s, 'smartreport.feature_disabled'); await go(s);
    const rb = at(s, /^rollback to savepoint\b/i); const between = s.db.stmts.slice(markAt(s), rb).filter((x) => /^(insert|update|delete)\b/i.test(x.text));
    expect(between).toHaveLength(0);
  });
});
