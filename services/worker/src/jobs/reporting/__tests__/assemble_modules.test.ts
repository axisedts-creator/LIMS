// C6-T32 — task `reporting.assemble_report`: micro / anatomic sections from fixture views (IS-21) and smart section integration (IS-22).
// Spec: 02-TRD §4.3 (sources table: "micro / anatomic content: micro.v_pub_report_content / anatomic.v_pub_report_content by ResultView.moduleRef (CR-C6-006)";
//   smart: buildSummary only if the tenant flag is on, only status 'approved', smartreport.* -> omitted; snapshot columns all-or-none), TRD §3.2 (section `content` = ROW of the view),
//   §4.5 rule 3 (micro phase preliminary -> report_kind preliminary), 03-IC §6.8, PRD AC-02.8, 01-PRD §Views read ("only these two views"), 07-SECURITY (tenant isolation, T1).
// ASSUMED: the assembler reads the view with a single-table SELECT filtered by tenant_id + entity_id + version_no (T04-fake dialect, no JOIN); the section's `content` is that row with
//   its 03-IC column names; a moduleRef without a view row is an integrity error (assembly rejects, no version) — same rule as "never a silently shorter report" in document.ts.
// The smart tests pin behaviour that already exists in assemble_report.ts (regression guards); the micro/anatomic tests fail until the sections are assembled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HASH_2, PORTAL_ORIGIN, build, settle, snapshotOf, versionRow, type Setup } from './assemble.helpers.js';
import { ANAT_ENTITY, ITEM_ANAT, ITEM_MICRO, MICRO_ENTITY, TENANT_A, TENANT_B, anatRow, idN, microRow, moduleSetup, viewStmts } from './assemble.modules.helpers.js';

beforeEach(() => { vi.stubEnv('LIMS_ORIGIN_PORTAL', PORTAL_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });
const go = async (s: Setup) => { const h = await build(s); await s.run(h); return s.versions(); };
const attempt = async (s: Setup) => { const h = await build(s); return settle(s.run(h)); };
const sections = (s: Setup, kind: string) => (snapshotOf(s.versions()[0]!).sections as any[]).filter((x) => x.kind === kind);
const json = (x: unknown) => JSON.stringify(x);

describe('IS-21 — micro section from micro.v_pub_report_content', () => {
  it('one micro section: orderItemId, test name from CatalogPort, phase from the row, content = the row of the moduleRef version (not the stale v1, not another entity)', async () => {
    const s = moduleSetup({ anatomic: false, microRows: [microRow({ version_no: 1, culture_summary_text: 'SYNTH-CULT-V1 STALE' }), microRow(), microRow({ entity_id: idN(0x3bff), culture_summary_text: 'SYNTH-OTHER-ENTITY' })] });
    await go(s); const m = sections(s, 'micro');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'micro', orderItemId: ITEM_MICRO, testName: 'Synthetic urine culture', phase: 'final' });
    expect(m[0].content).toMatchObject({ entity_id: MICRO_ENTITY, version_no: 2, culture_summary_text: 'SYNTH-CULT-V2 growth of E. coli', report_phase: 'final', comments_text: 'SYNTH-MICRO-COMMENT' });
    expect(m[0].content.isolates).toEqual(microRow().isolates); expect(m[0].content.ast).toEqual(microRow().ast);
    expect(json(snapshotOf(s.versions()[0]!))).not.toMatch(/STALE|OTHER-ENTITY/);
  });
  it('jsonb columns that arrive as JSON strings are parsed into arrays (driver-independent)', async () => {
    const r = microRow(); const s = moduleSetup({ anatomic: false, microRows: [{ ...r, isolates: JSON.stringify(r['isolates']), ast: JSON.stringify(r['ast']) }] });
    await go(s); const c = sections(s, 'micro')[0].content;
    expect(Array.isArray(c.isolates) && Array.isArray(c.ast)).toBe(true); expect(c.ast[0].antibiotic_display).toBe('Ciprofloxacin (synthetic)');
  });
  it('micro phase preliminary -> section.phase preliminary and the VERSION is report_kind preliminary / "Preliminary", no amendment box (§4.5 rule 3, AC-02.8)', async () => {
    const s = moduleSetup({ anatomic: false, microPhase: 'preliminary' }); await go(s); const v = s.versions()[0]!; const snap = snapshotOf(v);
    expect(sections(s, 'micro')[0].phase).toBe('preliminary'); expect(v['report_kind']).toBe('preliminary');
    expect(snap).toMatchObject({ reportKind: 'preliminary', statusLabel: 'Preliminary', amendmentNotes: [] });
  });
  it('micro phase final -> report_kind final', async () => {
    const s = moduleSetup({ anatomic: false }); await go(s); expect(s.versions()[0]!['report_kind']).toBe('final'); expect(sections(s, 'micro')[0].phase).toBe('final');
  });
  it('the view is read by (tenant_id, entity_id, version_no) from the moduleRef, with the tenant as a bound parameter', async () => {
    const s = moduleSetup({ anatomic: false }); await go(s); const q = viewStmts(s);
    expect(q.length).toBeGreaterThan(0);
    for (const x of q) { expect(x.verb).toBe('select'); expect(x.text).toMatch(/tenant_id\s*=\s*\$\d/i); expect(x.values).toContain(TENANT_A); expect(x.values).toContain(MICRO_ENTITY); expect(x.values).toContain(2); }
  });
});

describe('IS-21 — anatomic section from anatomic.v_pub_report_content', () => {
  it('one anatomic section: orderItemId, test name, content = the row (accession, texts, images with bucket/object_path/sha256/caption as given by the view)', async () => {
    const s = moduleSetup({ micro: false }); await go(s); const a = sections(s, 'anatomic');
    expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ kind: 'anatomic', orderItemId: ITEM_ANAT, testName: 'Synthetic skin biopsy' });
    expect(a[0].content).toMatchObject({ entity_id: ANAT_ENTITY, version_no: 1, accession_no: 'SYN-AP-26-0001', case_kind: 'histology', impression_text: 'SYNTH-IMPRESSION-V1', clinical_history_text: 'SYNTH-HISTORY' });
    expect(a[0].content.images).toEqual(anatRow().images);
  });
  it('a later anatomic version is picked by moduleRef.versionNo only (v1 requested while v2 exists in the view -> v1 content)', async () => {
    const s = moduleSetup({ micro: false, anatRows: [anatRow(), anatRow({ version_no: 2, impression_text: 'SYNTH-IMPRESSION-V2-NOT-REQUESTED', version_kind: 'amendment' })] });
    await go(s); expect(sections(s, 'anatomic')[0].content.impression_text).toBe('SYNTH-IMPRESSION-V1'); expect(json(snapshotOf(s.versions()[0]!))).not.toContain('NOT-REQUESTED');
  });
  it('anatomic does not turn the version into preliminary/amended: a normal complete report stays final', async () => {
    const s = moduleSetup({ micro: false }); await go(s); expect(s.versions()[0]!['report_kind']).toBe('final');
  });
});

describe('IS-21 — module amendment reasons reach the version kind (02-TRD §4.5 rules 1-2; review C6-T32 item 1)', () => {
  const released = () => [versionRow(1, { status: 'released', released_at: '2026-11-07T08:00:00.000Z', release_basis: 'zero_balance', release_mode: 'auto', audiences: ['patient'] })];
  const snapOf = (s: Setup) => { const v = s.versions().at(-1)!; return { v, snap: snapshotOf(v) }; };
  it('(a) anatomic result amended with supplementary_report over an earlier release -> addendum / "Addendum", no amendment box (excluded reason)', async () => {
    const s = moduleSetup({ micro: false, anatAmend: 'supplementary_report', world: { versions: released(), hash: HASH_2 } }); await go(s);
    const { v, snap } = snapOf(s); expect(s.versions()).toHaveLength(2);
    expect(v['report_kind']).toBe('addendum'); expect(snap).toMatchObject({ reportKind: 'addendum', statusLabel: 'Addendum', amendmentNotes: [] });
  });
  it('(a) the same without an earlier release is still addendum (rule 2 does not need a release)', async () => {
    const s = moduleSetup({ micro: false, anatAmend: 'supplementary_report' }); await go(s); expect(s.versions()[0]!['report_kind']).toBe('addendum');
  });
  it('(b) micro final with module_phase_progression over a released preliminary -> final, no amendment box', async () => {
    const s = moduleSetup({ anatomic: false, microAmend: 'module_phase_progression', world: { versions: [versionRow(1, { status: 'released', released_at: '2026-11-07T08:00:00.000Z', report_kind: 'preliminary', release_basis: 'zero_balance', release_mode: 'auto', audiences: ['patient'] })], hash: HASH_2 } });
    await go(s); const { v, snap } = snapOf(s);
    expect(v['report_kind']).toBe('final'); expect(snap).toMatchObject({ reportKind: 'final', statusLabel: 'Final', amendmentNotes: [] });
  });
  it.each([
    ['micro', 'corrected_value', 'Synthetic urine culture'], ['anatomic', 'corrected_value', 'Synthetic skin biopsy'], ['micro', 'wrong_patient_sample', 'Synthetic urine culture'],
  ])('(c) %s result amended with %s after a release -> amended, the amendment box names the test', async (mod, reason, testName) => {
    const s = moduleSetup({ micro: mod === 'micro', anatomic: mod === 'anatomic', ...(mod === 'micro' ? { microAmend: reason } : { anatAmend: reason }), world: { versions: released(), hash: HASH_2 } });
    await go(s); const { v, snap } = snapOf(s);
    expect(v['report_kind']).toBe('amended'); expect(snap).toMatchObject({ reportKind: 'amended', statusLabel: 'Amended' });
    const n = snap.amendmentNotes.find((x: any) => x.analyteOrSection === testName);
    expect(n).toMatchObject({ analyteOrSection: testName, previousVersionNo: 1, reasonCode: reason, reasonText: 'Synthetic module amendment', amendedAt: '2026-11-07T09:45:00.000Z' });
  });
  it('(c) the same module amendment with NO earlier release is just final (amended needs a release)', async () => {
    const s = moduleSetup({ anatomic: false, microAmend: 'corrected_value' }); await go(s); expect(s.versions()[0]!['report_kind']).toBe('final');
  });
});

describe('IS-21 — both modules + the lab sections together', () => {
  it('snapshot has department sections (from the lab results) AND micro AND anatomic; the frozen content hash covers them', async () => {
    const s = moduleSetup(); await go(s); const v = s.versions()[0]!; const snap = snapshotOf(v);
    expect(snap.sections.some((x: any) => x.kind === 'department')).toBe(true);
    expect(snap.sections.filter((x: any) => x.kind === 'micro')).toHaveLength(1); expect(snap.sections.filter((x: any) => x.kind === 'anatomic')).toHaveLength(1);
    expect(v['content_sha256']).toMatch(/^[0-9a-f]{64}$/); expect(json(snap)).toContain('SYNTH-CULT-V2'); expect(json(snap)).toContain('SYNTH-IMPRESSION-V1');
  });
  it('the module views are read only (no INSERT/UPDATE/DELETE on micro.* / anatomic.*; 01-PRD "Views read")', async () => {
    const s = moduleSetup(); await go(s);
    expect(s.db.writes().filter((x) => /\b(micro|anatomic)\./i.test(x.text))).toEqual([]);
    expect(viewStmts(s).length).toBeGreaterThanOrEqual(2);
    expect(s.db.stmts.filter((x) => /\b(micro|anatomic)\./i.test(x.text) && !/\b(micro|anatomic)\.v_pub_report_content\b/i.test(x.text))).toEqual([]);   // no other micro./anatomic. object
  });
});

describe('IS-21 — failure and isolation', () => {
  it('moduleRef points at a view row that does not exist -> assembly rejects and creates NO version (never a silently shorter report)', async () => {
    const s = moduleSetup({ anatomic: false, microRows: [] });
    expect(await attempt(s)).not.toBe('ok'); expect(s.versions()).toHaveLength(0); expect(s.qr()).toHaveLength(0); expect(s.renderJobs()).toHaveLength(0);
  });
  it('tenant isolation: a tenant-B row with the same (entity_id, version_no) is never used — RLS emulation OFF, so the statement itself must filter by tenant', async () => {
    const s = moduleSetup({ anatomic: false, rls: false, microRows: [microRow({ tenant_id: TENANT_B, culture_summary_text: 'SYNTH-TENANT-B-LEAK' }), microRow()] });
    await go(s); expect(json(snapshotOf(s.versions()[0]!))).not.toContain('TENANT-B-LEAK'); expect(sections(s, 'micro')[0].content.culture_summary_text).toBe('SYNTH-CULT-V2 growth of E. coli');
  });
  it('tenant isolation: when only tenant B has the row, assembly fails instead of leaking it (RLS emulation OFF)', async () => {
    const s = moduleSetup({ anatomic: false, rls: false, microRows: [microRow({ tenant_id: TENANT_B, culture_summary_text: 'SYNTH-TENANT-B-LEAK' })] });
    expect(await attempt(s)).not.toBe('ok'); expect(s.versions()).toHaveLength(0);
  });
  it('a lab-only order never touches the module views', async () => {
    const s = moduleSetup({ micro: false, anatomic: false }); await go(s);
    expect(viewStmts(s)).toEqual([]); expect(s.versions()).toHaveLength(1); expect(sections(s, 'micro')).toHaveLength(0); expect(sections(s, 'anatomic')).toHaveLength(0);
  });
  it('a hostile text in a view row is stored verbatim as data (escaping is the renderer\'s job) and does not break the JSON snapshot', async () => {
    const EVIL = '<script>alert(1)</script>"\\ ';
    const s = moduleSetup({ anatomic: false, microRows: [microRow({ culture_summary_text: EVIL })] }); await go(s);
    expect(snapshotOf(s.versions()[0]!).sections.find((x: any) => x.kind === 'micro').content.culture_summary_text).toBe(EVIL);
  });
});

describe('IS-22 — smart section (SmartReportPort fake): approved only', () => {
  const SUMMARY = (status: string, over: Record<string, unknown> = {}) => ({ summaryId: idN(0x5a01), orderId: idN(0x1), reportVersionNo: 1, templateLibraryVersion: 'lib-SYN-1', status, panels: [], deranged: [], advice: [], followUps: [], trends: [],
    disclaimerBlockId: idN(0x5a02), disclaimerText: 'SYNTH-DISCLAIMER', ...over });
  const withSmart = (status: string | Error, over: Record<string, unknown> = {}) => {
    const s = moduleSetup({ micro: false, anatomic: false, smartFlag: true });
    (s.ports.ports as any).smartreport.buildSummary = async (_c: unknown, i: unknown) => { s.ports.calls.smart.push(i); if (status instanceof Error) throw status; return SUMMARY(status, over); };
    return s;
  };
  it('approved summary: snapshot.smart carries summaryId + templateLibraryVersion + the summary as returned; the three snapshot columns are set (all-or-none, 05-SCHEMA §2.3)', async () => {
    const s = withSmart('approved'); await go(s); const v = s.versions()[0]!; const snap = snapshotOf(v);
    expect(s.ports.calls.smart).toEqual([{ orderId: v['order_id'], version: 1 }]);
    expect(snap.smart).toMatchObject({ summaryId: idN(0x5a01), templateLibraryVersion: 'lib-SYN-1', payload: { status: 'approved', disclaimerText: 'SYNTH-DISCLAIMER' } });
    const col = typeof v['smart_summary_json'] === 'string' ? JSON.parse(v['smart_summary_json']) : v['smart_summary_json'];
    expect(col).toMatchObject({ summaryId: idN(0x5a01), status: 'approved' }); expect(v['smart_summary_id']).toBe(idN(0x5a01)); expect(v['smart_summary_version']).toBe('lib-SYN-1');
  });
  it('draft summary (not approved): section omitted, snapshot has no smart key, all three columns NULL — nothing of the draft is stored anywhere in the version', async () => {
    const s = withSmart('draft', { disclaimerText: 'SYNTH-DRAFT-ONLY' }); await go(s); const v = s.versions()[0]!;
    expect(snapshotOf(v).smart).toBeUndefined(); expect(v['smart_summary_json'] ?? null).toBeNull(); expect(v['smart_summary_id'] ?? null).toBeNull(); expect(v['smart_summary_version'] ?? null).toBeNull();
    expect(JSON.stringify(v)).not.toContain('SYNTH-DRAFT-ONLY');
  });
  it.each(['pending', 'rejected', 'APPROVED', ''])('unknown/other status %j is treated as not approved (strict match on "approved")', async (st) => {
    const s = withSmart(st); await go(s); const v = s.versions()[0]!; expect(snapshotOf(v).smart).toBeUndefined(); expect(v['smart_summary_json'] ?? null).toBeNull();
  });
  it.each(['smartreport.feature_disabled', 'smartreport.no_eligible_results', 'smartreport.template_not_approved'])('port throws %s -> section omitted, version still created, columns NULL', async (code) => {
    const s = withSmart(Object.assign(new Error('x'), { code })); await go(s); const v = s.versions()[0]!;
    expect(s.versions()).toHaveLength(1); expect(snapshotOf(v).smart).toBeUndefined(); expect(v['smart_summary_json'] ?? null).toBeNull(); expect(v['smart_summary_id'] ?? null).toBeNull();
  });
  it('a non-smartreport error is NOT swallowed (infrastructure failure must retry, not silently drop the section)', async () => {
    const s = withSmart(Object.assign(new Error('db down'), { code: 'common.unavailable' }));
    expect(await attempt(s)).not.toBe('ok'); expect(s.versions()).toHaveLength(0);
  });
  it('flag off: the port is not called even if it would return an approved summary', async () => {
    const s = moduleSetup({ micro: false, anatomic: false }); (s.ports.ports as any).smartreport.buildSummary = async () => { s.ports.calls.smart.push(1); return SUMMARY('approved'); };
    await go(s); expect(s.ports.calls.smart).toHaveLength(0); expect(snapshotOf(s.versions()[0]!).smart).toBeUndefined();
  });
  it('smart + micro + anatomic together: all three present, version kind unaffected by the smart section (final)', async () => {
    const s = moduleSetup({ smartFlag: true }); (s.ports.ports as any).smartreport.buildSummary = async () => SUMMARY('approved');
    await go(s); const snap = snapshotOf(s.versions()[0]!);
    expect(snap.smart.summaryId).toBe(idN(0x5a01)); expect(snap.sections.some((x: any) => x.kind === 'micro')).toBe(true); expect(snap.sections.some((x: any) => x.kind === 'anatomic')).toBe(true); expect(s.versions()[0]!['report_kind']).toBe('final');
  });
});
