// C14 T12 — summary.service.buildOrGet: build, determinism, binding, guards, tenant isolation (06-PLAN row T12; 02-TRD §4.10, §7.1; 03-APP-FLOW §2.4, E19).
// ACs: AC-08.1 .. AC-08.6. Security: REQ-SEC-022..024 (tenant from ctx, never input), no PHI in stored content / logs, bad input. Seams: ./t12.fakes.ts header.
// Integration: the REAL service + engine over repository emulators (vi.mock of the T02 repositories) and port fakes. Fails now: ../summary.service.js does not exist.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repository/summaries.repo.js', async () => (await import('./t12.fakes.js')).summariesRepoFake);
vi.mock('../repository/bindings.repo.js', async () => (await import('./t12.fakes.js')).bindingsRepoFake);
vi.mock('../repository/library.repo.js', async () => (await import('./t12.fakes.js')).libraryRepoFake);
vi.mock('../repository/blocks.repo.js', async () => (await import('./t12.fakes.js')).blocksRepoFake);
vi.mock('../repository/rules.repo.js', async () => (await import('./t12.fakes.js')).rulesRepoFake);
vi.mock('../repository/mappings.repo.js', async () => (await import('./t12.fakes.js')).mappingsRepoFake);
vi.mock('../repository/groups.repo.js', async () => (await import('./t12.fakes.js')).groupsRepoFake);
vi.mock('../repository/codedSets.repo.js', async () => (await import('./t12.fakes.js')).codedSetsRepoFake);

import { buildOrGet } from '../summary.service.js';
import {
  AN, CENTRE, ORDER, PATIENT, REG_NO, TA, TB, VER, ac081, amend, approveLibrary, callsOf, contentSha256, lib, logText, makeCtx, portCallsOf, result, run, seed, setResults,
  sorted, w, LimsError,
} from './t12.fakes.js';

const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected the call to be refused'); };
const build = (ctx: any, input: Record<string, unknown> = {}) => run(ctx, () => buildOrGet(ctx, { orderId: ORDER.a, ...input } as any));
const panel = (s: any, code: string) => s.content.panels.find((p: any) => p.panelCode === code);
beforeEach(() => { seed(); approveLibrary(1); vi.clearAllMocks(); });

describe('C14-T12 buildOrGet — AC-08.1 first build', () => {
  it('HGB L + five N, all mapped: a draft row, panels blood_counts out_of_range / liver + kidney in_range, one deranged HGB low out_of_range', async () => {
    const { summary, created } = await build(makeCtx(), { reportVersionNo: 1 });
    expect(created).toBe(true);
    expect(summary).toMatchObject({ status: 'draft', order_id: ORDER.a, patient_id: PATIENT.a, centre_id: CENTRE.a, tenant_id: TA, library_version_id: VER(1), template_library_version: '1', formula_version: 'hs-1', language: 'en' });
    expect(panel(summary, 'blood_counts').status).toBe('out_of_range');
    expect(panel(summary, 'liver').status).toBe('in_range');
    expect(panel(summary, 'kidney').status).toBe('in_range');
    expect(summary.content.deranged).toHaveLength(1);
    expect(summary.content.deranged[0]).toMatchObject({ analyteId: AN.HGB, direction: 'low', severity: 'out_of_range' });
    expect(summary).toMatchObject({ deranged_count: 1, critical_count: 0, unmapped_result_count: 0, ignored_duplicate_count: 0 });
    expect(w.summaries).toHaveLength(1);
  });
  it('stored columns are consistent: content_sha256 = SHA-256 of the canonical content, health score mirrors content, approved_set_hash = LabPort hash, built_at set, no lifecycle fields', async () => {
    const { summary } = await build(makeCtx());
    expect(summary.content_sha256).toBe(contentSha256(summary.content));
    expect(summary.approved_set_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.approved_set_hash).toBe((await (await import('./t12.fakes.js')).LabPort.getOrderResults(makeCtx(), { orderId: ORDER.a, scope: 'approved' })).approvedSetHash);
    expect(summary.health_score_value).toBe(summary.content.healthScore.value);
    expect(summary.health_score_band).toBe(summary.content.healthScore.band);
    expect(summary.panels_scored).toBe(summary.content.healthScore.panelsScored);
    expect(summary.built_at).toBeTruthy();
    expect(summary).toMatchObject({ approved_at: null, rejected_at: null, superseded_at: null, superseded_by_summary_id: null, use_llm_text: false });
  });
  it('insert row carries only the allow-listed columns, never status / tenant_id / created_by (repository stamps them; tenant from ctx)', async () => {
    await build(makeCtx());
    const row = callsOf('insertSummary')[0]!.args[0] as Record<string, unknown>;
    for (const k of ['status', 'tenant_id', 'created_by', 'updated_by', 'version', 'approved_at', 'superseded_by_summary_id']) expect(row).not.toHaveProperty(k);
    expect(callsOf('insertSummary')[0]!.tenantId).toBe(TA);
  });
  it('AC-08.6: every deranged[].resultId and panels[].resultIds[] is a result id of LabPort.getOrderResults(approved)', async () => {
    const ids = new Set((w.results.get(ORDER.a) ?? []).map((r) => r.resultId));
    const { summary } = await build(makeCtx());
    for (const d of summary.content.deranged) expect(ids.has(d.resultId)).toBe(true);
    for (const p of summary.content.panels) for (const id of p.resultIds) expect(ids.has(id)).toBe(true);
  });
  it('the build reads results with scope "approved" (never all_visible)', async () => {
    await build(makeCtx());
    expect(portCallsOf('getOrderResults').every((c) => c.input.scope === 'approved')).toBe(true);
    expect(portCallsOf('getOrderResults').length).toBeGreaterThan(0);
  });
});

describe('C14-T12 buildOrGet — AC-08.2 determinism and bindings', () => {
  it('same call again: same summary id, identical content, created=false, no second row, no engine re-insert', async () => {
    const first = await build(makeCtx(), { reportVersionNo: 1 });
    const again = await build(makeCtx(), { reportVersionNo: 1 });
    expect(again.created).toBe(false);
    expect(again.summary.id).toBe(first.summary.id);
    expect(again.summary.content).toEqual(first.summary.content);
    expect(w.summaries).toHaveLength(1);
    expect(callsOf('insertSummary')).toHaveLength(1);
  });
  it('binding rows: version 1 -> one row; same version again -> still one; version 2 -> a second row (report_version_no 2) on the SAME summary', async () => {
    const a = await build(makeCtx(), { reportVersionNo: 1 });
    expect(w.bindings.map((b) => b.report_version_no)).toEqual([1]);
    await build(makeCtx(), { reportVersionNo: 1 });
    expect(w.bindings).toHaveLength(1);
    const c = await build(makeCtx(), { reportVersionNo: 2 });
    expect(c.summary.id).toBe(a.summary.id);
    expect(w.bindings.map((b) => b.report_version_no).sort()).toEqual([1, 2]);
    expect(w.bindings.every((b) => b.summary_id === a.summary.id && b.order_id === ORDER.a && b.centre_id === CENTRE.a && b.tenant_id === TA)).toBe(true);
  });
  it('no reportVersionNo (staff #30 / prebuild): no binding row is written', async () => {
    await build(makeCtx(), { mode: 'prebuild' });
    await build(makeCtx(), { mode: 'current' });
    expect(w.bindings).toHaveLength(0);
    expect(callsOf('insertBinding')).toHaveLength(0);
  });
  it('a rejected live summary with the same hash is returned as is (the service does not map status; no new row)', async () => {
    const first = await build(makeCtx());
    Object.assign(w.summaries[0]!, { status: 'rejected', rejected_at: new Date(), rejected_by_membership_id: uid0(), reject_reason_code: 'other', version: 2 });
    const again = await build(makeCtx(), { reportVersionNo: 3 });
    expect(again.summary.id).toBe(first.summary.id);
    expect(again.summary.status).toBe('rejected');
    expect(w.summaries).toHaveLength(1);
  });
  it('an approved live summary with the same hash is returned unchanged', async () => {
    const first = await build(makeCtx());
    Object.assign(w.summaries[0]!, { status: 'approved', approved_at: new Date(), approved_by_membership_id: uid0(), version: 2 });
    const again = await build(makeCtx(), { reportVersionNo: 1 });
    expect(again.summary.id).toBe(first.summary.id);
    expect(again.summary.status).toBe('approved');
    expect(w.updates).toHaveLength(0);
  });
});
const uid0 = (): string => '01900000-7200-7000-8000-000000007500';

describe('C14-T12 buildOrGet — input_result_versions (05-SCHEMA §2.8, 02-TRD §4.10)', () => {
  it('= EVERY approved result:version (mapped or not, text included), sorted ascending, exactly the set hashed', async () => {
    setResults(ORDER.a, [...ac081(), result(7, 'TXT', null)]);                          // an unmapped text result is in the hashed set
    const { summary } = await build(makeCtx());
    const all = (w.results.get(ORDER.a) ?? []).map((r) => `${r.resultId}:${r.versionNo}`);
    expect(summary.input_result_versions).toHaveLength(7);
    expect(summary.input_result_versions).toEqual(sorted(all));
    expect(summary.unmapped_result_count).toBeGreaterThanOrEqual(1);
  });
  it('a version bump is reflected (<uuid>:2)', async () => {
    amend(ORDER.a, ac081()[1]!.resultId);
    const { summary } = await build(makeCtx());
    expect(summary.input_result_versions.filter((s: string) => s.endsWith(':2'))).toHaveLength(1);
  });
  it('2,000 approved results build; the stored array has 2,000 elements', async () => {
    setResults(ORDER.a, [...ac081(), ...Array.from({ length: 1994 }, (_, i) => result(100 + i, 'TXT', null))]);
    const { summary } = await build(makeCtx());
    expect(summary.input_result_versions).toHaveLength(2000);
  });
  it('2,001 approved results -> smartreport.no_eligible_results, reason too_many_results logged, no insert, no CHECK violation (E19)', async () => {
    setResults(ORDER.a, [...ac081(), ...Array.from({ length: 1995 }, (_, i) => result(100 + i, 'TXT', null))]);
    const ctx = makeCtx();
    const e = await fails(build(ctx));
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('smartreport.no_eligible_results');
    expect(w.writes).toEqual([]);
    expect(logText(ctx)).toContain('too_many_results');
  });
});

describe('C14-T12 buildOrGet — refusals (AC-08.3, AC-08.4, template, tenant)', () => {
  it('AC-08.3 no approved results -> smartreport.no_eligible_results; nothing written', async () => {
    setResults(ORDER.a, []);
    const e = await fails(build(makeCtx(), { reportVersionNo: 1 }));
    expect(e.code).toBe('smartreport.no_eligible_results');
    expect(w.writes).toEqual([]);
  });
  it('AC-08.3 results exist but none approved -> no_eligible_results', async () => {
    setResults(ORDER.a, ac081().map((r) => ({ ...r, status: 'resulted' })));
    expect((await fails(build(makeCtx()))).code).toBe('smartreport.no_eligible_results');
  });
  it('AC-08.4 fewer mapped eligible results than min_mapped_results (3) -> no_eligible_results; no insert, no binding', async () => {
    setResults(ORDER.a, [result(1, 'HGB', 'L'), result(2, 'WBC'), result(7, 'TXT', null), result(8, 'TXT', null)]);
    expect((await fails(build(makeCtx(), { reportVersionNo: 1 }))).code).toBe('smartreport.no_eligible_results');
    expect(w.writes).toEqual([]);
  });
  it('AC-08.4 the threshold is the LIBRARY parameter: min_mapped_results = 2 lets the same two-result order build', async () => {
    lib.versions.find((v) => v.id === VER(1))!.min_mapped_results = 2;
    setResults(ORDER.a, [result(1, 'HGB', 'L'), result(2, 'WBC')]);
    expect((await build(makeCtx())).summary.status).toBe('draft');
  });
  it('AC-08.4 a result with neither flag nor reference snapshot is not eligible (AC-08.7) and does not count toward the minimum', async () => {
    setResults(ORDER.a, [result(1, 'HGB', 'L'), result(2, 'WBC'), result(3, 'PLT', null)]);
    expect((await fails(build(makeCtx()))).code).toBe('smartreport.no_eligible_results');
  });
  it('no approved library -> smartreport.template_not_approved; nothing written', async () => {
    lib.versions.length = 0;
    const e = await fails(build(makeCtx()));
    expect(e.code).toBe('smartreport.template_not_approved');
    expect(w.writes).toEqual([]);
  });
  it('a library that is only draft / in_review / retired is not active -> template_not_approved', async () => {
    for (const status of ['draft', 'in_review', 'retired']) { lib.versions[0]!.status = status; expect((await fails(build(makeCtx()))).code).toBe('smartreport.template_not_approved'); }
  });
  it('AC-08.5 an order of tenant_b built in tenant_a context -> common.not_found; nothing written, no row anywhere', async () => {
    setResults(ORDER.b, ac081());
    const e = await fails(build(makeCtx('A'), { orderId: ORDER.b }));
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('common.not_found');
    expect(w.writes).toEqual([]); expect(w.summaries).toEqual([]);
  });
  it('a FrontdeskPort not_found propagates as the original LimsError (P-23); an unknown order id is the same', async () => {
    const e = await fails(build(makeCtx(), { orderId: '01900000-7200-7000-8000-0000deadbeef' }));
    expect(e.code).toBe('common.not_found');
  });
  it('a CatalogPort analyte-read error is NOT swallowed: it propagates with its code and nothing is inserted (P-23)', async () => {
    w.opts.analyteReadError = 'common.not_found';
    expect((await fails(build(makeCtx()))).code).toBe('common.not_found');
    w.opts.analyteReadError = 'common.internal';
    expect((await fails(build(makeCtx()))).code).toBe('common.internal');
    expect(w.writes).toEqual([]);
  });
});

describe('C14-T12 buildOrGet — bad input and security (REQ-SEC-022..024, AB: injection / malformed)', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null])('reportVersionNo %s -> common.validation_failed, nothing written', async (v) => {
    const e = await fails(build(makeCtx(), { reportVersionNo: v }));
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('common.validation_failed');
    expect(w.writes).toEqual([]);
  });
  it.each(['', 'not-a-uuid', "x'; DROP TABLE smartreport.summaries; --", '00000000-0000-0000-0000-000000000000/../..', undefined, 42])('orderId %s is refused with a LimsError, nothing written', async (id) => {
    const e = await fails(build(makeCtx(), { orderId: id }));
    expect(e).toBeInstanceOf(LimsError);
    expect(w.writes).toEqual([]);
  });
  it('unknown mode is refused (no silent fallthrough to a build)', async () => {
    const e = await fails(build(makeCtx(), { mode: 'nuke' }));
    expect(e).toBeInstanceOf(LimsError);
    expect(w.writes).toEqual([]);
  });
  it('tenant isolation: every repository call carries the ctx tenant; tenant_b builds its own summary, tenant_a is untouched', async () => {
    const a = await build(makeCtx('A'));
    lib.versions.push({ ...lib.versions[0]!, id: VER(9), tenant_id: TB, version_no: 1 });
    lib.blocks.push(...lib.blocks.filter((b) => b.library_version_id === VER(1)).map((b) => ({ ...b, tenant_id: TB, library_version_id: VER(9) })));
    lib.rules.push(...lib.rules.filter((b) => b.library_version_id === VER(1)).map((b) => ({ ...b, tenant_id: TB, library_version_id: VER(9) })));
    lib.mappings.push(...lib.mappings.filter((b) => b.library_version_id === VER(1)).map((b) => ({ ...b, tenant_id: TB, library_version_id: VER(9) })));
    lib.groupSettings.push(...lib.groupSettings.filter((b) => b.library_version_id === VER(1)).map((b) => ({ ...b, tenant_id: TB, library_version_id: VER(9) })));
    setResults(ORDER.b, ac081());
    const b = await build(makeCtx('B'), { orderId: ORDER.b });
    expect(b.summary).toMatchObject({ tenant_id: TB, library_version_id: VER(9), centre_id: CENTRE.b });
    expect(a.summary.id).not.toBe(b.summary.id);
    for (const c of w.calls.filter((x) => x.tenantId !== undefined)) expect([TA, TB]).toContain(c.tenantId);
    expect(callsOf('insertSummary').map((c) => c.tenantId)).toEqual([TA, TB]);
    expect(w.summaries.find((s) => s.id === a.summary.id)!.tenant_id).toBe(TA);
  });
  it('ids in the insert row come from the ports (patient, centre), never from the caller input', async () => {
    const { summary } = await build(makeCtx(), { patientId: 'evil', centreId: 'evil', tenantId: TB, library_version_id: 'evil' });
    expect(summary).toMatchObject({ patient_id: PATIENT.a, centre_id: CENTRE.a, tenant_id: TA, library_version_id: VER(1) });
  });
  it('no PHI leaks: the registration number is not in the stored row; logs/metrics carry no block text, values or patient id', async () => {
    const ctx = makeCtx();
    const { summary } = await build(ctx, { reportVersionNo: 1 });
    expect(JSON.stringify(summary)).not.toContain(REG_NO);
    const logs = logText(ctx);
    for (const s of ['13.40', 'g/dL', 'Hemoglobin', 'does not replace', REG_NO, PATIENT.a, 'reference range']) expect(logs).not.toContain(s);
  });
  it('every port call is made with the caller ctx tenant (no cross-tenant port use)', async () => {
    await build(makeCtx('A'));
    expect(w.portCalls.length).toBeGreaterThan(0);
    expect(w.portCalls.every((c) => c.tenantId === TA)).toBe(true);
  });
  it('the advisory lock is taken before any summaries read/write and names tenant + order (02-TRD §4.10)', async () => {
    await build(makeCtx(), { reportVersionNo: 1 });
    expect(w.lockCalls).toHaveLength(1);
    const l = w.lockCalls[0]!;
    expect(l.text).toMatch(/pg_advisory_xact_lock\(\s*hashtextextended\(/i);
    expect(JSON.stringify([l.text, l.values])).toContain(TA);
    expect(JSON.stringify([l.text, l.values])).toContain(ORDER.a);
    const names = w.calls.map((c) => c.fn);
    const firstSummaryOp = names.findIndex((n) => ['getLiveSummaryByOrder', 'findSummaryByDeterminismKey', 'insertSummary', 'updateSummary', 'insertBinding'].includes(n));
    expect(names.indexOf('lock')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('lock')).toBeLessThan(firstSummaryOp);
  });
  it('approved_set_hash is the port value verbatim (03-IC §4.5: SHA-256 of sorted result_id:version_no), also when the result list order differs', async () => {
    const { createHash } = await import('node:crypto');
    w.results.set(ORDER.a, [...ac081()].reverse());
    const { summary } = await build(makeCtx());
    const own = createHash('sha256').update((w.results.get(ORDER.a) ?? []).map((r) => `${r.resultId}:${r.versionNo}`).sort().join('\n')).digest('hex');
    expect(summary.approved_set_hash).toBe(own);
  });
});
