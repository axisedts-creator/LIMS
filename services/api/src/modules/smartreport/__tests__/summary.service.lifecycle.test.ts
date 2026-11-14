// C14 T12 — summary.service.buildOrGet: concurrency, supersede (+ S6), AC-15.4, pinning across library approval (AC-07.5), rebuild_with_active_library, P-44 savepoints.
// Spec: 02-TRD §4.10, §7.1 steps 5-8, §7.2; 03-APP-FLOW §1.2 S1/S5/S6, §2.5; 05-SCHEMA §4/§5; 08 A19 D-107 (S6), P-44 (marker tests), D-111. Seams: ./t12.fakes.ts header.
// Integration: the REAL service + engine over repository emulators that enforce the unique indexes, the live-summary index and the S5/S6 transition trigger. Fails now: ../summary.service.js missing.
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
  AN, ORDER, PATIENT, TEST_ID, VER, ac081, amend, approveLibrary, callsOf, enableTrend, libWithFollowup, lib, makeCtx, portCallsOf, result, retireLibrary, run, seed, setResults,
  uid, w, withRange, LimsError,
} from './t12.fakes.js';

const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected the call to be refused'); };
const build = (ctx: any, input: Record<string, unknown> = {}) => run(ctx, () => buildOrGet(ctx, { orderId: ORDER.a, ...input } as any));
const HGB_ID = ac081()[0]!.resultId;
const updatesOf = (id: string) => w.updates.filter((u) => u.id === id);
const order2 = () => [result(21, 'HGB', 'L'), result(22, 'WBC'), result(23, 'PLT'), result(24, 'ALT'), result(25, 'AST'), result(26, 'CREAT')];
beforeEach(() => { seed(); approveLibrary(1); vi.clearAllMocks(); });

describe('C14-T12 concurrency — two parallel builds give one row (02-TRD §4.10 advisory lock)', () => {
  it('two parallel builds of one order: one summary row, one insert, same id for both, exactly one created=true; both bindings recorded', async () => {
    const [x, y] = await Promise.all([build(makeCtx(), { reportVersionNo: 1 }), build(makeCtx(), { reportVersionNo: 2 })]);
    expect(w.summaries).toHaveLength(1);
    expect(callsOf('insertSummary')).toHaveLength(1);
    expect(x.summary.id).toBe(y.summary.id);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(w.bindings.map((b) => b.report_version_no).sort()).toEqual([1, 2]);
    expect(w.lockCalls).toHaveLength(2);
  });
  it('eight parallel builds (same report version): one row, one insert, one binding', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => build(makeCtx(), { reportVersionNo: 1 })));
    expect(new Set(rs.map((r) => r.summary.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(w.summaries).toHaveLength(1);
    expect(w.bindings).toHaveLength(1);
  });
  it('parallel builds after a hash change: ONE successor, the old row superseded once, superseded_by set exactly once (no invalid S6 transition)', async () => {
    const first = await build(makeCtx());
    amend(ORDER.a, HGB_ID); w.updates.length = 0;
    const rs = await Promise.all([build(makeCtx()), build(makeCtx()), build(makeCtx())]);
    expect(new Set(rs.map((r) => r.summary.id)).size).toBe(1);
    expect(rs[0]!.summary.id).not.toBe(first.summary.id);
    expect(w.summaries).toHaveLength(2);
    expect(updatesOf(first.summary.id)).toHaveLength(2);
    expect(updatesOf(first.summary.id).filter((u) => 'superseded_by_summary_id' in u.patch)).toHaveLength(1);
    expect(w.summaries.filter((s) => ['draft', 'approved', 'rejected'].includes(s.status))).toHaveLength(1);
  });
  it('different orders do not serialise on one lock: two orders in parallel -> two rows, two different lock keys', async () => {
    setResults(ORDER.a2, order2());
    const [x, y] = await Promise.all([build(makeCtx(), { orderId: ORDER.a }), build(makeCtx(), { orderId: ORDER.a2 })]);
    expect(x.summary.id).not.toBe(y.summary.id);
    expect(new Set(w.lockCalls.map((l) => JSON.stringify([l.text, l.values]))).size).toBe(2);
  });
});

describe('C14-T12 supersede on hash change (7b) — AC-15.4, 08 A19 D-107', () => {
  it('AC-15.4 (consumer off): LabPort hash changed -> old live summary superseded (results_changed), new draft built, old never returned, successor id set once AFTER the insert', async () => {
    const first = await build(makeCtx(), { reportVersionNo: 1 });
    amend(ORDER.a, HGB_ID); w.updates.length = 0; w.calls.length = 0;
    const next = await build(makeCtx(), { reportVersionNo: 2 });
    expect(next.created).toBe(true);
    expect(next.summary.id).not.toBe(first.summary.id);
    expect(next.summary.status).toBe('draft');
    expect(next.summary.approved_set_hash).not.toBe(first.summary.approved_set_hash);
    const old = w.summaries.find((s) => s.id === first.summary.id)!;
    expect(old).toMatchObject({ status: 'superseded', superseded_reason: 'results_changed', superseded_by_summary_id: next.summary.id });
    expect(old.superseded_at).toBeTruthy();
    expect(old.content).toEqual(first.summary.content);                                  // content columns untouched
    const ups = updatesOf(first.summary.id);
    expect(ups).toHaveLength(2);
    expect(Object.keys(ups[0]!.patch).sort()).toEqual(['status', 'superseded_at', 'superseded_reason']);   // S5: no successor id yet
    expect(ups[1]!.patch).toEqual({ superseded_by_summary_id: next.summary.id });                            // S6: one column, NULL -> id
    const names = w.calls.map((c) => c.fn);
    expect(names.indexOf('insertSummary')).toBeGreaterThan(names.indexOf('updateSummary'));
    expect(names.lastIndexOf('updateSummary')).toBeGreaterThan(names.indexOf('insertSummary'));
    expect(w.bindings.map((b) => [b.summary_id, b.report_version_no])).toEqual([[first.summary.id, 1], [next.summary.id, 2]]);
  });
  it('the new summary hashes the NEW set: input_result_versions holds the bumped version, the old row keeps the old one', async () => {
    const first = await build(makeCtx());
    amend(ORDER.a, HGB_ID);
    const next = await build(makeCtx());
    expect(next.summary.input_result_versions).toContain(`${HGB_ID}:2`);
    expect(next.summary.input_result_versions).not.toContain(`${HGB_ID}:1`);
    expect(first.summary.input_result_versions).toContain(`${HGB_ID}:1`);
  });
  it.each(['draft', 'approved', 'rejected'])('a %s live summary is superseded the same way; approved/rejected fields are kept', async (status) => {
    const first = await build(makeCtx());
    const s = w.summaries[0]!;
    if (status === 'approved') Object.assign(s, { status, approved_at: new Date('2026-11-06T00:00:00Z'), approved_by_membership_id: uid(0x7500), version: 2 });
    if (status === 'rejected') Object.assign(s, { status, rejected_at: new Date('2026-11-06T00:00:00Z'), rejected_by_membership_id: uid(0x7500), reject_reason_code: 'other', version: 2 });
    amend(ORDER.a, HGB_ID);
    const next = await build(makeCtx());
    const old = w.summaries.find((x) => x.id === first.summary.id)!;
    expect(old).toMatchObject({ status: 'superseded', superseded_reason: 'results_changed', superseded_by_summary_id: next.summary.id });
    if (status === 'approved') expect(old.approved_at).toBeTruthy();
    expect(next.summary.status).toBe('draft');
  });
  it('AC-15.4 (consumer already ran): the old row is already superseded and nothing is live -> a new draft is built; the old one is not returned nor superseded a second time', async () => {
    const first = await build(makeCtx());
    Object.assign(w.summaries[0]!, { status: 'superseded', superseded_at: new Date(), superseded_reason: 'results_changed', version: 2 });
    amend(ORDER.a, HGB_ID); w.updates.length = 0;
    const next = await build(makeCtx(), { reportVersionNo: 1 });
    expect(next.created).toBe(true);
    expect(next.summary.id).not.toBe(first.summary.id);
    expect(next.summary.status).toBe('draft');
    expect(w.updates.filter((u) => 'status' in u.patch)).toEqual([]);                   // no second supersede (would be an invalid_transition)
  });
  it('hash changed but no approved library: old summary is superseded (results_changed), superseded_by STAYS NULL, no insert, no S6, error template_not_approved', async () => {
    const first = await build(makeCtx());
    amend(ORDER.a, HGB_ID); retireLibrary(1); w.updates.length = 0;
    const e = await fails(build(makeCtx(), { reportVersionNo: 2 }));
    expect(e.code).toBe('smartreport.template_not_approved');
    expect(w.summaries).toHaveLength(1);
    expect(w.summaries[0]).toMatchObject({ id: first.summary.id, status: 'superseded', superseded_reason: 'results_changed', superseded_by_summary_id: null });
    expect(updatesOf(first.summary.id)).toHaveLength(1);
    expect(w.bindings.map((b) => b.report_version_no)).toEqual([]);
  });
  it('hash changed and fewer than min_mapped_results eligible: superseded, successor id stays NULL, no insert, no_eligible_results', async () => {
    const first = await build(makeCtx());
    setResults(ORDER.a, [result(1, 'HGB', 'L', { versionNo: 2 }), result(2, 'WBC')]); w.updates.length = 0;
    const e = await fails(build(makeCtx()));
    expect(e.code).toBe('smartreport.no_eligible_results');
    expect(w.summaries).toHaveLength(1);
    expect(w.summaries[0]).toMatchObject({ id: first.summary.id, status: 'superseded', superseded_by_summary_id: null });
    expect(updatesOf(first.summary.id)).toHaveLength(1);
  });
  it('no approved results at all (step 4) is refused BEFORE any supersede: the live summary stays live, no update', async () => {
    const first = await build(makeCtx());
    setResults(ORDER.a, []); w.updates.length = 0;
    expect((await fails(build(makeCtx()))).code).toBe('smartreport.no_eligible_results');
    expect(w.summaries[0]).toMatchObject({ id: first.summary.id, status: 'draft' });
    expect(w.updates).toEqual([]);
  });
  it('supersede and S6 go through the tenant-scoped repository ctx and only touch allow-listed lifecycle columns (the repository emulator rejects anything else)', async () => {
    await build(makeCtx());
    amend(ORDER.a, HGB_ID);
    const ctx = makeCtx('A', 'user');
    await build(ctx);
    expect(callsOf('updateSummary').length).toBe(2);
    for (const c of callsOf('updateSummary')) expect(c.tenantId).toBe(ctx.tenantId);
  });
});

describe('C14-T12 pinning across library approval — AC-07.5 (02-TRD §4.10 DECISION)', () => {
  const v3Then4 = async () => {
    lib.versions.length = 0; lib.blocks.length = 0; lib.rules.length = 0; lib.mappings.length = 0; lib.groupSettings.length = 0;
    approveLibrary(3);
    const first = await build(makeCtx(), { reportVersionNo: 1 });
    retireLibrary(3); approveLibrary(4);
    return first;
  };
  it('summary built with version 3 is unchanged when version 4 is approved: same hash again returns the SAME row (library 3, template_library_version "3"), no insert, no update', async () => {
    const first = await v3Then4();
    expect(first.summary).toMatchObject({ library_version_id: VER(3), template_library_version: '3' });
    const before = structuredClone(w.summaries[0]);
    w.writes.length = 0; w.updates.length = 0;
    const again = await build(makeCtx(), { reportVersionNo: 2 });
    expect(again.created).toBe(false);
    expect(again.summary.id).toBe(first.summary.id);
    expect(again.summary).toMatchObject({ library_version_id: VER(3), template_library_version: '3' });
    expect(w.summaries).toHaveLength(1);
    expect(w.summaries[0]).toEqual(before);
    expect(w.writes).toEqual(['insertBinding']);                                         // only the new report version binding
  });
  it('mode current and prebuild also keep the pinned library', async () => {
    const first = await v3Then4();
    for (const mode of ['current', 'prebuild']) {
      const r = await build(makeCtx(), { mode });
      expect(r.summary.id).toBe(first.summary.id); expect(r.created).toBe(false);
    }
    expect(w.updates).toEqual([]);
  });
  it('a NEW approved set after version 4 is approved is built with version 4 (template_library_version "4"); the old row is superseded', async () => {
    const first = await v3Then4();
    amend(ORDER.a, HGB_ID);
    const next = await build(makeCtx(), { reportVersionNo: 2 });
    expect(next.summary).toMatchObject({ library_version_id: VER(4), template_library_version: '4', status: 'draft' });
    expect(w.summaries.find((s) => s.id === first.summary.id)).toMatchObject({ status: 'superseded', library_version_id: VER(3), superseded_by_summary_id: next.summary.id });
  });
  it('an approved set that has no summary yet (another order) uses version 4', async () => {
    await v3Then4();
    setResults(ORDER.a2, order2());
    const r = await build(makeCtx(), { orderId: ORDER.a2 });
    expect(r.summary).toMatchObject({ library_version_id: VER(4), template_library_version: '4' });
  });
  it('rebuild_with_active_library: live summary on version 3, active version 4 -> superseded (library_rebuild), new draft on version 4, successor id set once, created=true', async () => {
    const first = await v3Then4();
    w.updates.length = 0;
    const r = await build(makeCtx('A', 'user'), { mode: 'rebuild_with_active_library' });
    expect(r.created).toBe(true);
    expect(r.summary).toMatchObject({ library_version_id: VER(4), status: 'draft', approved_set_hash: first.summary.approved_set_hash });
    expect(w.summaries.find((s) => s.id === first.summary.id)).toMatchObject({ status: 'superseded', superseded_reason: 'library_rebuild', superseded_by_summary_id: r.summary.id });
    expect(updatesOf(first.summary.id)).toHaveLength(2);
    expect(w.bindings.map((b) => b.report_version_no)).toEqual([1]);                      // no binding without reportVersionNo
  });
  it('rebuild_with_active_library when the live summary already uses the active library: existing row, created=false, nothing written', async () => {
    const first = await build(makeCtx());
    w.writes.length = 0;
    const r = await build(makeCtx('A', 'user'), { mode: 'rebuild_with_active_library' });
    expect(r.created).toBe(false); expect(r.summary.id).toBe(first.summary.id);
    expect(w.writes).toEqual([]);
  });
  it('rebuild_with_active_library with no live summary builds like current', async () => {
    const r = await build(makeCtx('A', 'user'), { mode: 'rebuild_with_active_library' });
    expect(r.created).toBe(true); expect(r.summary.status).toBe('draft');
  });
  it('rebuild_with_active_library with no approved library -> template_not_approved and the live summary is NOT superseded', async () => {
    const first = await build(makeCtx());
    retireLibrary(1); w.updates.length = 0;
    expect((await fails(build(makeCtx('A', 'user'), { mode: 'rebuild_with_active_library' }))).code).toBe('smartreport.template_not_approved');
    expect(w.summaries[0]).toMatchObject({ id: first.summary.id, status: 'draft' });
    expect(w.updates).toEqual([]);
  });
});

describe('C14-T12 history / follow-up port calls run in savepoints — P-44 marker rows (02-TRD §7.2)', () => {
  const fuMarker = (id: string) => `catalog:${id}`;
  it('follow-up test lookup: CatalogPort.getTest({testId, requireActive: true}) inside a savepoint; an active test yields the suggestion with the rule\'s intervalDays', async () => {
    lib.versions.length = 0; lib.blocks.length = 0; lib.rules.length = 0; lib.mappings.length = 0; lib.groupSettings.length = 0;
    approveLibrary(1, libWithFollowup(TEST_ID.fu));
    const { summary } = await build(makeCtx());
    const calls = portCallsOf('getTest').filter((c) => c.input.testId === TEST_ID.fu);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.requireActive).toBe(true);
    expect(calls[0]!.inSavepoint).toBe(true);
    expect(summary.content.followUps).toHaveLength(1);
    expect(summary.content.followUps[0]).toMatchObject({ suggestedTestCode: 'HGB2', intervalDays: 30 });
    expect(w.markers).toContain(fuMarker(TEST_ID.fu));                                    // a successful savepoint keeps what the port wrote
  });
  it.each([['inactive', TEST_ID.fuInactive], ['unknown', uid(0xc0ff)]])('%s follow-up test: suggestion skipped, build still succeeds, the failed port call\'s marker row is rolled back', async (_n, testId) => {
    lib.versions.length = 0; lib.blocks.length = 0; lib.rules.length = 0; lib.mappings.length = 0; lib.groupSettings.length = 0;
    approveLibrary(1, libWithFollowup(testId));
    const { summary } = await build(makeCtx());
    expect(summary.status).toBe('draft');
    expect(summary.content.followUps).toEqual([]);
    expect(portCallsOf('getTest').find((c) => c.input.testId === testId)!.inSavepoint).toBe(true);
    expect(w.markers).not.toContain(fuMarker(testId));
    expect(w.spDepth).toBe(0);
  });
  it('analyte reads (CatalogPort.getTest by result testId with asOf) are plain reads, and every follow-up lookup is in a savepoint', async () => {
    lib.versions.length = 0; lib.blocks.length = 0; lib.rules.length = 0; lib.mappings.length = 0; lib.groupSettings.length = 0;
    approveLibrary(1, libWithFollowup(TEST_ID.fu));
    await build(makeCtx());
    const reads = portCallsOf('getTest').filter((c) => c.input.requireActive !== true);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.input.asOf !== undefined)).toBe(true);
    expect(portCallsOf('getTest').filter((c) => c.input.requireActive === true).every((c) => c.inSavepoint)).toBe(true);
  });
  it('trend history: LabPort.getAnalyteHistory({ includeLegacy: false }) for the order\'s patient is called inside a savepoint', async () => {
    enableTrend('HGB');
    setResults(ORDER.a, [{ ...withRange(ac081()[0]!) }, ...ac081().slice(1)]);
    await build(makeCtx());
    const calls = portCallsOf('getAnalyteHistory');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) { expect(c.inSavepoint).toBe(true); expect(c.input.includeLegacy).toBe(false); expect(c.input.patientId).toBe(PATIENT.a); }
    expect(calls.some((c) => c.input.analyteIds.includes(AN.HGB))).toBe(true);
  });
  it.each(['internal', 'down'] as const)('history error (%s): trends empty, build succeeds, the marker row the failed call wrote is rolled back, savepoint closed', async (mode) => {
    enableTrend('HGB'); w.opts.history = mode;
    setResults(ORDER.a, [{ ...withRange(ac081()[0]!) }, ...ac081().slice(1)]);
    const { summary } = await build(makeCtx());
    expect(summary.status).toBe('draft');
    expect(summary.content.trends).toEqual([]);
    expect(w.markers.some((m) => m.startsWith('history:'))).toBe(false);
    expect(w.spDepth).toBe(0);
    expect(w.summaries).toHaveLength(1);
  });
  it('history succeeds: its marker row is kept (savepoint released, not rolled back)', async () => {
    enableTrend('HGB');
    setResults(ORDER.a, [{ ...withRange(ac081()[0]!) }, ...ac081().slice(1)]);
    await build(makeCtx());
    expect(w.markers.some((m) => m === `history:${PATIENT.a}`)).toBe(true);
  });
  it('the cached path (live summary, same hash) calls neither history nor follow-up lookups and never re-runs the engine', async () => {
    await build(makeCtx());
    w.portCalls.length = 0; w.calls.length = 0;
    await build(makeCtx());
    expect(portCallsOf('getAnalyteHistory')).toEqual([]);
    expect(portCallsOf('getTest')).toEqual([]);
    expect(callsOf('insertSummary', 'updateSummary')).toEqual([]);
  });
  it('a typed LimsError from a handled port path never escapes as a different code: the unhandled ones keep their code', async () => {
    w.opts.analyteReadError = 'catalog.test_inactive';
    const e = await fails(build(makeCtx()));
    expect(e).toBeInstanceOf(LimsError);
    expect(e.code).toBe('catalog.test_inactive');
  });
});
