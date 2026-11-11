// C14 T12 — the emulators themselves behave like the DB/ports they stand in for (so a green T12 run means something). No service code involved.
import { beforeEach, describe, expect, it } from 'vitest';
import { LimsError, ORDER, TA, VER, ac081, approveLibrary, bindingsRepoFake, makeCtx, run, seed, summariesRepoFake, w, LabPort, lib } from './t12.fakes.js';

const rc = () => ({ tenantId: TA, actorId: 'a', tx: {} });
const row = (o: Record<string, unknown> = {}) => ({ id: `01900000-7200-7000-8000-${String(Math.random()).slice(2, 14).padStart(12, '0')}`, centre_id: 'c', order_id: ORDER.a, patient_id: 'p', library_version_id: VER(1),
  template_library_version: '1', formula_version: 'hs-1', language: 'en', approved_set_hash: 'a'.repeat(64), input_result_versions: ['x:1'], content: {}, content_sha256: 'b'.repeat(64),
  panels_scored: 0, deranged_count: 0, critical_count: 0, unmapped_result_count: 0, ignored_duplicate_count: 0, built_at: 't', ...o });
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected failure'); };
beforeEach(() => { seed(); approveLibrary(1); });

describe('T12 emulators', () => {
  it('unique determinism key, one live summary per order, 1..2000 inputs, lifecycle-only update columns', async () => {
    const a = await summariesRepoFake.insertSummary(rc(), row());
    expect((await fails(summariesRepoFake.insertSummary(rc(), row({ approved_set_hash: 'c'.repeat(64) })))).code).toBe('23505');      // second live
    expect((await fails(summariesRepoFake.insertSummary(rc(), row({ input_result_versions: [] })))).code).toBe('23514');
    expect((await fails(summariesRepoFake.insertSummary(rc(), row({ status: 'approved' })))).message).toContain('not allowed');
    expect((await fails(summariesRepoFake.updateSummary(rc(), a.id, 1, { content: {} }))).message).toContain('not allowed');
  });
  it('S5 has no successor id; S6 sets it once, NULL -> id, nothing else; stale version conflicts', async () => {
    const a = await summariesRepoFake.insertSummary(rc(), row());
    expect((await fails(summariesRepoFake.updateSummary(rc(), a.id, 1, { status: 'superseded', superseded_at: 't', superseded_reason: 'results_changed', superseded_by_summary_id: a.id }))).code).toBe('P0001');
    const s = await summariesRepoFake.updateSummary(rc(), a.id, 1, { status: 'superseded', superseded_at: 't', superseded_reason: 'results_changed' });
    expect((await fails(summariesRepoFake.updateSummary(rc(), a.id, 1, { superseded_by_summary_id: a.id }))).code).toBe('common.version_conflict');
    const b = await summariesRepoFake.insertSummary(rc(), row({ approved_set_hash: 'd'.repeat(64) }));
    expect((await fails(summariesRepoFake.updateSummary(rc(), a.id, s.version, { superseded_reason: 'library_rebuild' }))).code).toBe('P0001');
    await summariesRepoFake.updateSummary(rc(), a.id, s.version, { superseded_by_summary_id: b.id });
    expect((await fails(summariesRepoFake.updateSummary(rc(), a.id, s.version + 1, { superseded_by_summary_id: b.id }))).code).toBe('P0001');
  });
  it('bindings: duplicate (summary, version) is a silent no-op (ON CONFLICT DO NOTHING)', async () => {
    const a = await summariesRepoFake.insertSummary(rc(), row());
    const b = { id: 'i', centre_id: 'c', summary_id: a.id, order_id: ORDER.a, report_version_no: 1, bound_at: 't' };
    expect(await bindingsRepoFake.insertBinding(rc(), b)).toBeTruthy(); expect(await bindingsRepoFake.insertBinding(rc(), b)).toBeNull(); expect(w.bindings).toHaveLength(1);
  });
  it('advisory lock serialises two transactions on one key until release; reentrant inside one tx', async () => {
    const q = (c: any) => c.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['k']);
    const c1 = makeCtx(), c2 = makeCtx(); const order: string[] = [];
    await q(c1); await q(c1);
    const p = q(c2).then(() => order.push('c2'));
    await new Promise((r) => setTimeout(r, 20)); order.push('c1-release'); c1.release(); await p;
    expect(order).toEqual(['c1-release', 'c2']); c2.release();
  });
  it('savepoint rolls back port markers on error, keeps them on success; LabPort hash is order-independent; other tenant order is not_found', async () => {
    const ctx = makeCtx();
    await ctx.tx.savepoint(async () => { w.markers.push('ok'); });
    await fails(ctx.tx.savepoint(async () => { w.markers.push('bad'); throw new Error('x'); }));
    expect(w.markers).toEqual(['ok']);
    const x = await LabPort.getOrderResults(ctx, { orderId: ORDER.a, scope: 'approved' });
    w.results.set(ORDER.a, [...ac081()].reverse());
    expect((await LabPort.getOrderResults(ctx, { orderId: ORDER.a, scope: 'approved' })).approvedSetHash).toBe(x.approvedSetHash);
    expect((await fails(LabPort.getOrderResults(makeCtx('B'), { orderId: ORDER.a, scope: 'approved' }))).code).toBe('common.not_found');
    await run(ctx, async () => undefined); expect(lib.versions.some((v) => v.status === 'approved')).toBe(true); expect(LimsError).toBeDefined();
  });
});
