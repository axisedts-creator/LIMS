// C9 T-12 — run.service.evaluateNow (QR5 via #30; 03-APP-FLOW §2.1; 02-TRD §7.3 step 7 / §7.7; PRD AC-06.7-06.8 reused) against the T-10 harness (fake RunRepo + real event log + real createQualityEvents).
// Seam (review.helpers.ts): `createRunService(...).evaluateNow(ctx, { runId, planId })` -> updated run row. The review service passes the plan id of the run it already read; the run service
// takes the pair lock FIRST (repo.lockPlan(planId)), re-reads the plan's collecting run under it, refuses when it is not `runId`, finalises like close_stale_runs (mode final) with
// evaluated_by = ctx.actor.id, publishes quality.qc_run.rejected.v1 in the same tx iff rejected. Fails now: "svc.evaluateNow is not a function".
import { describe, expect, it } from 'vitest';
import { RUN, OBS, PLN, TENANT_A, USER, at, makeRunHarness, rejection, code } from './run.helpers.js';

const staff = (h: ReturnType<typeof makeRunHarness>) => h.ctx({ actor: { type: 'user', id: USER, membershipId: USER } });
const evalNow = (h: ReturnType<typeof makeRunHarness>, runId = RUN(1), planId = PLN(1)) => (h.svc as any).evaluateNow(staff(h), { runId, planId });
/** A collecting run of PLN(1) at 08:00 with ONE member (composition needs L1 + L2): the run is incomplete until the window passes or someone evaluates it. */
const collecting = (h: ReturnType<typeof makeRunHarness>, z: number) => { h.seedRun(1, { observation_count: 1 }); h.seedMember(RUN(1), 1, 1, z, at('08:00:00')); };

describe('evaluateNow finalises a collecting run (QR5)', () => {
  it('an incomplete run with no rule hit -> status evaluated, outcome incomplete, is_complete false, evaluated_at = ctx.now(), evaluated_by = the staff actor; version + 1; no event', async () => {
    const h = makeRunHarness(); collecting(h, 0.3); h.at(at('08:12:00'));
    const r = await h.transaction(() => evalNow(h));
    expect(r).toMatchObject({ id: RUN(1), status: 'evaluated', outcome: 'incomplete', is_complete: false, evaluated_at: at('08:12:00'), evaluated_by: USER, version: 2 });
    expect(h.run(RUN(1))).toMatchObject({ status: 'evaluated', outcome: 'incomplete' }); expect(h.stored()).toHaveLength(0);
  });
  it('a 1-2s warning alone stays a warning in an incomplete run: outcome incomplete, warning_rules [1-2s] (TRD §7.3, same as the stale close)', async () => {
    const h = makeRunHarness(); collecting(h, 2.5); const r = await h.transaction(() => evalNow(h));
    expect(r).toMatchObject({ outcome: 'incomplete', is_complete: false, warning_rules: ['1-2s'] }); expect(h.stored()).toHaveLength(0);
  });
  it('a member that violates 1-3s -> outcome rejected, rules_violated [1-3s], hold_since per H2 (no prior in-control run: run_at - hold_lookback_hours), ONE event in the same tx whose aggregate seq is the new run version', async () => {
    const h = makeRunHarness(); collecting(h, 3.5); h.at(at('08:12:00'));
    const r = await h.transaction(() => evalNow(h));
    expect(r).toMatchObject({ status: 'evaluated', outcome: 'rejected', is_complete: false, rules_violated: ['1-3s'], hold_since: '2026-11-12T08:00:00.000Z', evaluated_by: USER });
    expect(r['last_in_control_run_at'] ?? null).toBeNull(); expect(h.stored()).toHaveLength(1);
    const e = h.stored()[0]!; expect(e.key).toBe(`${RUN(1)}:rejected`); expect(e.envelope).toMatchObject({ event_type: 'quality.qc_run.rejected.v1', tenant_id: TENANT_A, aggregate: { type: 'qc_run', id: RUN(1), seq: r['version'] } });
    expect(h.run(RUN(1))['rejection_event_id']).toBe(e.eventId);
  });
  it('H1: with an earlier accepted_warning run at 06:00 the hold starts there (last_in_control_run_at = hold_since = 06:00)', async () => {
    const h = makeRunHarness(); h.seedPrior(5, 'accepted_warning', at('06:00:00')); collecting(h, 3.5);
    const r = await h.transaction(() => evalNow(h)); expect(r).toMatchObject({ outcome: 'rejected', last_in_control_run_at: at('06:00:00'), hold_since: at('06:00:00') });
  });
  it('evaluating twice: the second call is refused with quality.qc_run_already_evaluated and publishes nothing more (exactly one event per rejected run)', async () => {
    const h = makeRunHarness(); collecting(h, 3.5); await h.transaction(() => evalNow(h));
    expect(code(await rejection(h.transaction(() => evalNow(h))))).toBe('quality.qc_run_already_evaluated'); expect(h.stored()).toHaveLength(1);
  });
  it('a run that is already evaluated or closed is refused; its row is untouched', async () => {
    for (const status of ['evaluated', 'closed']) {
      const h = makeRunHarness(); h.seedPrior(1, 'accepted', at('08:00:00'), { status, ...(status === 'closed' ? { closed_at: at('09:00:00'), closed_by: USER } : {}) }); const before = structuredClone(h.run(RUN(1)));
      expect(code(await rejection(h.transaction(() => evalNow(h)))), status).toBe('quality.qc_run_already_evaluated'); expect(h.run(RUN(1))).toEqual(before); expect(h.stored()).toHaveLength(0);
    }
  });
  it('a run id that is not the plan\'s collecting run (another run of the plan is collecting) is refused and the collecting one is NOT evaluated by mistake', async () => {
    const h = makeRunHarness(); collecting(h, 3.5); h.seedPrior(2, 'accepted', at('06:00:00'));
    expect(code(await rejection(h.transaction(() => evalNow(h, RUN(2)))))).toBe('quality.qc_run_already_evaluated'); expect(h.run(RUN(1))['status']).toBe('collecting'); expect(h.stored()).toHaveLength(0);
  });
  it('an unknown plan (invisible / other tenant) -> common.not_found; nothing written', async () => {
    const h = makeRunHarness(); collecting(h, 3.5);
    expect(code(await rejection(h.transaction(() => evalNow(h, RUN(1), PLN(77)))))).toBe('common.not_found'); expect(h.stored()).toHaveLength(0); expect(h.run(RUN(1))['status']).toBe('collecting');
  });
});

describe('evaluateNow under the pair lock, atomically', () => {
  it('lockPlan(planId) is the FIRST repository call, on the request tx; the collecting run is read after it', async () => {
    const h = makeRunHarness(); collecting(h, 0.3); await h.transaction(() => evalNow(h));
    expect(h.calls[0]).toMatchObject({ op: 'lockPlan', tenantId: TENANT_A, args: [PLN(1)] }); expect(h.calls.findIndex((c) => c.op === 'findCollectingRun')).toBeGreaterThan(0);
    for (const c of h.calls) expect(c.tx, c.op).toBe(h.db.tx);
  });
  it('a rollback undoes both the run update and the event (same transaction)', async () => {
    const h = makeRunHarness(); collecting(h, 3.5);
    let seen: any; await h.transaction(async () => { seen = await evalNow(h); }, { rollback: true }).catch(() => undefined);
    expect(seen).toMatchObject({ status: 'evaluated', outcome: 'rejected' });   // it did run inside the transaction ...
    expect(h.run(RUN(1))['status']).toBe('collecting'); expect(h.stored()).toHaveLength(0);   // ... and was fully undone
  });
  it('a failing event publish fails the whole evaluation and leaves the run collecting (no rejected run without its event)', async () => {
    const h = makeRunHarness({ hooks: { failOp: { latestInControlRunAt: new Error('db down') } } }); collecting(h, 3.5);
    expect((await rejection(h.transaction(() => evalNow(h)))).message).toBe('db down'); expect(h.run(RUN(1))['status']).toBe('collecting'); expect(h.stored()).toHaveLength(0);
  });
  it('the clock is ctx.now(): one reading drives evaluated_at', async () => {
    const h = makeRunHarness(); collecting(h, 0.3); h.at('2026-11-13T08:44:44.444Z'); const r = await h.transaction(() => evalNow(h)); expect(r['evaluated_at']).toBe('2026-11-13T08:44:44.444Z');
  });
});

describe('AC-07 integration across the two services is covered in review.service.test.ts; here only the evaluate-now row of 03-APP-FLOW QR5 is pinned (review row evaluate_now is written by the review service)', () => {
  it('observation ids of members are untouched by evaluate-now (members stay assigned and linked)', async () => {
    const h = makeRunHarness(); collecting(h, 0.3); await h.transaction(() => evalNow(h));
    expect(h.state.observations.filter((o) => o['qc_run_id'] === RUN(1)).map((o) => [o['id'], o['status']])).toEqual([[OBS(1), 'assigned']]);
  });
});
