// C9 T-10 — run service: assemble, evaluate, publish (02-TRD §7.3 steps 1-7 + 1a, §7.5, §7.7 H1-H4, §10.1, §14; 03-APP-FLOW QR1-QR6; PRD AC-06.6, AC-06.7, AC-06.8, AC-06.9; 07-SECURITY S-09).
// done_when: pair lock; event in the same tx (rollback test); hold_since H1-H4; qc_activity reset; late member of an early-rejected run attached without a second event;
//            close_stale_runs on last_assembled_at; gauge (worker test). SEAMS: see run.helpers.ts header. No database: fake RunRepo + the REAL core events.publish (schema-validating) over an in-memory tx.
// Fails now: "Cannot find module ../service/run.service.js" (and ../events/publish.js, ../repository/run.repo.js).
import { describe, expect, it } from 'vitest';
import { ANA, INS, LVL, OBS, PLN, RUN, SYSTEM, TENANT_A, TENANT_B, at, draft, makeRunHarness, rejection, idN } from './run.helpers.js';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const L1 = 1 as const, L2 = 2 as const;
const D1 = '2026-11-05', D = (hms: string) => at(hms, D1);

describe('assembly: open / join / evaluate (TRD §7.3 steps 2-5; QR1, QR2, QR4)', () => {
  it('QR1: the first assigned observation opens a collecting run with the snapshots and the tenant westgardMode', async () => {
    const h = makeRunHarness({ mode: 'modern' });
    const id = await h.place(draft(1, L1, 0.5, at('08:00:00'), { received_at: at('08:00:02') }));
    expect(id).toMatch(UUIDV7);
    expect(h.runs()).toHaveLength(1);
    expect(h.run(id)).toMatchObject({
      tenant_id: TENANT_A, plan_id: PLN(1), plan_version_no: 3, instrument_id: INS(1), analyte_id: ANA(1), controls_per_run: 2, rule_mode: 'modern', mean_rule: '8x',
      run_at: at('08:00:00'), last_member_received_at: at('08:00:02'), last_assembled_at: at('08:00:05'), observation_count: 1,
      status: 'collecting', outcome: null, evaluated_at: null, rules_violated: [], created_by: SYSTEM,
    });
    expect(h.identityCalls).toEqual([{ keys: ['westgardMode'] }]);
    expect(h.stored()).toHaveLength(0);
  });
  it('a tenant without a westgardMode value gets classic (D-QC-1); the mode is read at open time only and the run keeps it', async () => {
    const h = makeRunHarness({ mode: null });
    const id = await h.place(draft(1, L1, 0.5, at('08:00:00')));
    expect(h.run(id)['rule_mode']).toBe('classic');
    await h.place(draft(2, L2, 0.1, at('08:05:00')));
    expect(h.identityCalls).toHaveLength(1);
  });
  it('QR2 + QR4: a second level inside the window completes the run: evaluated, accepted, is_complete, count 2, evaluated_at = ctx.now(), no event', async () => {
    const h = makeRunHarness();
    const id = await h.place(draft(1, L1, 0.5, at('08:00:00')));
    h.at(at('08:05:07'));
    expect(await h.place(draft(2, L2, -0.3, at('08:05:00')))).toBe(id);
    expect(h.run(id)).toMatchObject({ status: 'evaluated', outcome: 'accepted', is_complete: true, observation_count: 2, rules_violated: [], warning_rules: [], evaluated_at: at('08:05:07'), evaluated_by: SYSTEM, last_assembled_at: at('08:05:07') });
    expect(h.stored()).toHaveLength(0);
  });
  it('AC-06.9: a run with only a 1-2s violation is accepted_warning, warning_rules [1-2s], no event', async () => {
    const h = makeRunHarness();
    const id = await h.place(draft(1, L1, 2.5, at('08:00:00')));
    expect(h.run(id)['status']).toBe('collecting');     // a warning is not a rejection: keep collecting
    await h.place(draft(2, L2, 0.1, at('08:02:00')));
    expect(h.run(id)).toMatchObject({ status: 'evaluated', outcome: 'accepted_warning', is_complete: true, rules_violated: [], warning_rules: ['1-2s'] });
    expect(h.stored()).toHaveLength(0);
  });
  it('a member that is outside the window (observed_at - run_at > run_window_minutes) finalises the collecting run as incomplete (step 3, no event) and opens a new run', async () => {
    const h = makeRunHarness();
    const a = await h.place(draft(1, L1, 0.5, at('08:00:00')));
    h.at(at('08:40:05'));
    const b = await h.place(draft(2, L2, 0.1, at('08:40:00')));
    expect(b).not.toBe(a);
    expect(h.run(a)).toMatchObject({ status: 'evaluated', outcome: 'incomplete', is_complete: false, observation_count: 1, evaluated_at: at('08:40:05') });
    expect(h.run(b)).toMatchObject({ status: 'collecting', run_at: at('08:40:00'), observation_count: 1 });
    expect(h.stored()).toHaveLength(0);
  });
  it('a second observation of a level that is already at its composition count finalises the collecting run (incomplete) and opens a new one (step 3)', async () => {
    const h = makeRunHarness();
    const a = await h.place(draft(1, L1, 0.5, at('08:00:00')));
    const b = await h.place(draft(2, L1, 0.6, at('08:15:00')));
    expect(b).not.toBe(a);
    expect(h.run(a)).toMatchObject({ outcome: 'incomplete', is_complete: false });
    expect(h.run(b)['status']).toBe('collecting');
  });
  it('the window is inclusive: exactly run_window_minutes after run_at joins, one second later does not', async () => {
    for (const [secs, joins] of [['30:00', true], ['30:01', false]] as const) {
      const h = makeRunHarness();
      const a = await h.place(draft(1, L1, 0.5, at('08:00:00')));
      const b = await h.place(draft(2, L2, 0.1, at(`08:${secs}`)));
      expect(b === a, secs).toBe(joins);
    }
  });
  it('QR4 reaches the composition when N=3 {L1:1, L2:2}: not full after two, full after three', async () => {
    const h = makeRunHarness({ plan: { controls_per_run: 3, mean_rule: '9x', composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 2 }] } });
    const id = await h.place(draft(1, L1, 0.2, at('08:00:00')));
    await h.place(draft(2, L2, 0.2, at('08:01:00')));
    expect(h.run(id)['status']).toBe('collecting');
    await h.place(draft(3, L2, -0.2, at('08:02:00')));
    expect(h.run(id)).toMatchObject({ status: 'evaluated', outcome: 'accepted', is_complete: true, observation_count: 3, controls_per_run: 3, mean_rule: '9x' });
  });
  it('the Westgard options come from the plan and the run: rule_mode (modern evaluates 4-1s without a 1-2s warning, classic gates it) and history oldest-first', async () => {
    const hist = (h: ReturnType<typeof makeRunHarness>) => [1, 2, 3].forEach((i) => h.state.history.push({ ...draft(100 + i, L1, 1.2, D(`0${i}:00:00`)), id: idN(0xb800 + i), plan_id: PLN(1), qc_run_id: RUN(50 + i) }));
    const modern = makeRunHarness({ mode: 'modern' }); hist(modern);
    const m = await modern.place(draft(1, L1, 1.2, at('08:00:00')));
    expect(modern.run(m)).toMatchObject({ status: 'evaluated', outcome: 'rejected', is_complete: false, rules_violated: ['4-1s'] });
    expect(modern.stored()).toHaveLength(1);
    const classic = makeRunHarness({ mode: 'classic' }); hist(classic);
    const c = await classic.place(draft(1, L1, 1.2, at('08:00:00')));
    expect(classic.run(c)).toMatchObject({ status: 'collecting', outcome: null });
    expect(classic.stored()).toHaveLength(0);
  });
  it('listHistory is asked for the plan history without the run itself, with the plan flag exclude_rejected_runs_from_history, and a bounded limit', async () => {
    for (const flag of [true, false]) {
      const h = makeRunHarness({ plan: { exclude_rejected_runs_from_history: flag } });
      const id = await h.place(draft(1, L1, 0.5, at('08:00:00')));
      const q = h.callsOf('listHistory');
      expect(q.length).toBeGreaterThan(0);
      for (const c of q) {
        expect(c.args[0]).toBe(PLN(1));
        expect(c.args[1]).toMatchObject({ excludeRunId: id, excludeRejectedRuns: flag });
        expect((c.args[1] as any).limit).toBeGreaterThan(0);
        expect((c.args[1] as any).limit).toBeLessThanOrEqual(1000);
      }
    }
  });
});

describe('early rejection + late members (AC-06.6; AS1-AS3; QR3, QR6; 08 A17 D-52)', () => {
  const v27 = (h: ReturnType<typeof makeRunHarness>) => h.place(draft(1, L1, 3.4, at('08:00:00')));

  it('AS1: V27 (L1 z 3.4) rejects the run at once; an L2 member observed 08:10 attaches to the same run, outcome frozen, exactly one event', async () => {
    const h = makeRunHarness();
    const id = await v27(h);
    expect(h.run(id)).toMatchObject({ status: 'evaluated', outcome: 'rejected', is_complete: false, rules_violated: ['1-3s'], observation_count: 1, evaluated_at: at('08:00:05') });
    expect(h.stored()).toHaveLength(1);
    const before = structuredClone(h.run(id));
    h.at(at('08:10:09'));
    expect(await h.place(draft(2, L2, 0.2, at('08:10:00'), { received_at: at('08:10:03') }))).toBe(id);
    const r = h.run(id);
    expect(r).toMatchObject({ status: 'evaluated', outcome: 'rejected', is_complete: false, rules_violated: ['1-3s'], observation_count: 2, last_assembled_at: at('08:10:09'), last_member_received_at: at('08:10:03') });
    for (const k of ['outcome', 'rules_violated', 'warning_rules', 'is_complete', 'evaluated_at', 'hold_since', 'last_in_control_run_at', 'run_at', 'rule_mode']) expect(r[k], k).toEqual(before[k]);
    expect(h.runs()).toHaveLength(1);
    expect(h.stored()).toHaveLength(1);                       // no second event
  });
  it('AS1: the late member is never re-evaluated into a new rejection: a late 1-3s member changes neither outcome nor rules_violated and publishes nothing', async () => {
    const h = makeRunHarness();
    const id = await v27(h);
    h.at(at('08:05:00'));
    await h.place(draft(2, L2, -3.6, at('08:04:00')));        // would fire 1-3s and R-4s if the run were evaluated again
    expect(h.run(id)).toMatchObject({ outcome: 'rejected', rules_violated: ['1-3s'], is_complete: false, observation_count: 2 });
    expect(h.stored()).toHaveLength(1);
  });
  it('QR6: the hits of a late member are appended to rule_detail ({ rule, observation_ids }); the original detail stays', async () => {
    const h = makeRunHarness();
    const id = await v27(h);
    await h.place(draft(2, L2, -2.5, at('08:05:00')));        // R-4s with the V27 point
    const rd = h.run(id)['rule_detail'];
    expect(rd).toContainEqual({ rule: '1-3s', observation_ids: [OBS(1)] });
    expect(rd).toContainEqual({ rule: 'R-4s', observation_ids: expect.arrayContaining([OBS(2)]) });
    expect(h.run(id)['rules_violated']).toEqual(['1-3s']);
  });
  it('AS2: an L2 observed 08:40 (outside the window) opens a new collecting run; the rejected run is untouched; still one event', async () => {
    const h = makeRunHarness();
    const a = await v27(h);
    h.at(at('08:40:05'));
    const b = await h.place(draft(2, L2, 0.2, at('08:40:00')));
    expect(b).not.toBe(a);
    expect(h.run(a)).toMatchObject({ outcome: 'rejected', observation_count: 1, is_complete: false });
    expect(h.run(b)).toMatchObject({ status: 'collecting', observation_count: 1, run_at: at('08:40:00') });
    expect(h.stored()).toHaveLength(1);
  });
  it('AS3: a second L1 observed 08:15 (L1 count already = composition) opens a new run (step 4)', async () => {
    const h = makeRunHarness();
    const a = await v27(h);
    const b = await h.place(draft(2, L1, 0.3, at('08:15:00')));
    expect(b).not.toBe(a);
    expect(h.run(a)['observation_count']).toBe(1);
    expect(h.run(b)).toMatchObject({ status: 'collecting', observation_count: 1 });
  });
  it('a rejection that comes with the full composition (QR4, is_complete true) takes no late members: the next observation opens a new run', async () => {
    const h = makeRunHarness();
    const a = await h.place(draft(1, L1, 1.0, at('08:00:00')));
    const aa = await h.place(draft(2, L2, 3.5, at('08:05:00')));
    expect(aa).toBe(a);
    expect(h.run(a)).toMatchObject({ outcome: 'rejected', is_complete: true, rules_violated: ['1-3s'], observation_count: 2 });
    expect(h.stored()).toHaveLength(1);
    const b = await h.place(draft(3, L1, 0.0, at('08:10:00')));
    expect(b).not.toBe(a);
    expect(h.run(a)['observation_count']).toBe(2);
  });
  it('a collecting run wins over an older early-rejected run (step 1 before step 1a)', async () => {
    const h = makeRunHarness();
    const a = await v27(h);
    const b = await h.place(draft(2, L1, 0.3, at('08:15:00')));      // opens run b (AS3)
    const c = await h.place(draft(3, L2, 0.2, at('08:20:00')));      // b is collecting and L2 is free: joins b, not the rejected run a
    expect(c).toBe(b);
    expect(h.run(a)['observation_count']).toBe(1);
    expect(h.run(b)).toMatchObject({ is_complete: true, outcome: 'accepted' });
  });
  it('only the pair\'s LATEST early-rejected run takes late members (the repo is asked for exactly that run)', async () => {
    const h = makeRunHarness();
    await v27(h);
    await h.place(draft(2, L2, 0.2, at('08:10:00')));
    expect(h.callsOf('findLatestEarlyRejectedRun').every((c) => c.args[0] === PLN(1))).toBe(true);
  });
});

describe('rejection event + hold_since (AC-06.8; 02-TRD §7.7 H1-H4; 03-IC §3.21)', () => {
  const rejectAt = async (h: ReturnType<typeof makeRunHarness>, runAt: string, rejectedAt: string) => { h.at(rejectedAt); return h.place(draft(1, L1, 3.4, runAt)); };
  const payloadOf = (h: ReturnType<typeof makeRunHarness>) => h.stored()[0]!.envelope.payload;

  it('H1: last in-control run R2 accepted_warning 06:00 -> hold_since = last_in_control_run_at = 06:00', async () => {
    const h = makeRunHarness();
    h.seedPrior(2, 'accepted_warning', D('06:00:00'));
    const id = await rejectAt(h, D('09:00:00'), D('09:00:05'));
    expect(payloadOf(h)).toEqual({ qc_run_id: id, instrument_id: INS(1), analyte_ids: [ANA(1)], rules_violated: ['1-3s'], rule_mode: 'classic', controls_per_run: 2,
      run_at: D('09:00:00'), last_in_control_run_at: D('06:00:00'), hold_since: D('06:00:00'), rejected_at: D('09:00:05') });
    expect(h.run(id)).toMatchObject({ last_in_control_run_at: D('06:00:00'), hold_since: D('06:00:00') });
  });
  it('H2: no prior run, hold_lookback_hours 24 -> hold_since = run_at - 24 h and last_in_control_run_at is ABSENT (not null) in the payload', async () => {
    const h = makeRunHarness();
    const id = await rejectAt(h, D('06:00:00'), D('06:00:05'));
    const p = payloadOf(h);
    expect(p).not.toHaveProperty('last_in_control_run_at');
    expect(p['hold_since']).toBe(at('06:00:00', '2026-11-04'));
    expect(h.run(id)).toMatchObject({ last_in_control_run_at: null, hold_since: at('06:00:00', '2026-11-04') });
  });
  it('H2 variant: the lookback is the plan hold_lookback_hours (36 h)', async () => {
    const h = makeRunHarness({ plan: { hold_lookback_hours: 36 } });
    await rejectAt(h, D('06:00:00'), D('06:00:05'));
    expect(payloadOf(h)['hold_since']).toBe(at('18:00:00', '2026-11-03'));
  });
  it('H3: R1 accepted 01:00 and R5 incomplete 05:00 -> the incomplete run does not count: hold_since 01:00', async () => {
    const h = makeRunHarness();
    h.seedPrior(1, 'accepted', D('01:00:00'));
    h.seedPrior(5, 'incomplete', D('05:00:00'));
    await rejectAt(h, D('06:00:00'), D('06:00:05'));
    expect(payloadOf(h)).toMatchObject({ last_in_control_run_at: D('01:00:00'), hold_since: D('01:00:00') });
  });
  it('H4: the only in-control run is 4 days old -> still the hold_since (whatever its age)', async () => {
    const h = makeRunHarness();
    h.seedPrior(1, 'accepted', at('01:00:00', '2026-11-01'));
    await rejectAt(h, D('06:00:00'), D('06:00:05'));
    expect(payloadOf(h)).toMatchObject({ last_in_control_run_at: at('01:00:00', '2026-11-01'), hold_since: at('01:00:00', '2026-11-01') });
  });
  it('the in-control lookup is for the rejected run\'s own plan and run_at (rejected, later and other-plan runs are not asked for)', async () => {
    const h = makeRunHarness();
    h.seedPrior(1, 'rejected', D('07:00:00'));
    h.seedPrior(2, 'accepted', D('10:00:00'));                                  // after the rejected run
    h.seedPrior(3, 'accepted', D('05:00:00'), { plan_id: PLN(9) });             // another pair
    await rejectAt(h, D('09:00:00'), D('09:00:05'));
    const q = h.callsOf('latestInControlRunAt');
    expect(q).toHaveLength(1);
    expect(q[0]!.args).toEqual([PLN(1), D('09:00:00')]);
    expect(payloadOf(h)).not.toHaveProperty('last_in_control_run_at');
  });
  it('AC-06.8: envelope = producer quality, aggregate qc_run/<run id>/seq = the run version after the rejection, key <qc_run_id>:rejected; the run stores rejection_event_id', async () => {
    const h = makeRunHarness();
    const id = await rejectAt(h, D('09:00:00'), D('09:00:05'));
    const e = h.stored()[0]!;
    expect(h.stored()).toHaveLength(1);
    expect(e.key).toBe(`${id}:rejected`);
    expect(e.envelope).toMatchObject({ event_type: 'quality.qc_run.rejected.v1', producer: 'quality', tenant_id: TENANT_A, aggregate: { type: 'qc_run', id, seq: h.run(id)['version'] }, idempotency_key: `${id}:rejected` });
    expect(h.run(id)['rejection_event_id']).toBe(e.eventId);
  });
  it('the payload holds the 03-IC keys only (no values, no observation ids, no tenant, no actor)', async () => {
    const h = makeRunHarness();
    await rejectAt(h, D('09:00:00'), D('09:00:05'));
    expect(Object.keys(payloadOf(h)).sort()).toEqual(['analyte_ids', 'controls_per_run', 'hold_since', 'instrument_id', 'qc_run_id', 'rejected_at', 'rule_mode', 'rules_violated', 'run_at']);
  });
  it('rules_violated is in canonical order and within the event enum (2-2s + R-4s + 1-3s at completion)', async () => {
    const h = makeRunHarness();
    await h.place(draft(1, L1, 2.4, at('08:00:00')));
    await h.place(draft(2, L2, -3.2, at('08:01:00')));            // R-4s and 1-3s (2-2s needs the same side)
    const rv = payloadOf(h)['rules_violated'] as string[];
    const canon = ['1-3s', '2-2s', '2of3-2s', 'R-4s', '4-1s', '3-1s', '6x', '8x', '9x', '10x', '12x'];
    expect(rv).toEqual(['1-3s', 'R-4s']);
    expect(rv).toEqual(canon.filter((r) => rv.includes(r)));
  });
  it('accepted, accepted_warning and incomplete outcomes publish nothing (TRD §10.1)', async () => {
    const h = makeRunHarness();
    await h.place(draft(1, L1, 2.5, at('08:00:00')));
    await h.place(draft(2, L2, 0.1, at('08:01:00')));             // accepted_warning
    h.at(at('09:00:05'));
    await h.place(draft(3, L1, 0.5, at('09:00:00')));
    await h.svc.closeStaleRuns(h.ctx({ now: () => at('09:40:00') }));   // incomplete
    expect(h.runs().map((r) => r['outcome'])).toEqual(['accepted_warning', 'incomplete']);
    expect(h.stored()).toHaveLength(0);
  });
});

describe('same transaction: the event and the run commit or roll back together (02-CV §7.3 outbox; PRD AC-06.8)', () => {
  it('every repo call and the event INSERT run on ctx.tx with the ctx tenant (one transaction, one tenant)', async () => {
    const h = makeRunHarness();
    await h.place(draft(1, L1, 3.4, at('08:00:00')));
    expect(h.calls.length).toBeGreaterThan(0);
    for (const c of h.calls) { expect(c.tx, c.op).toBe(h.db.tx); expect(c.tenantId, c.op).toBe(TENANT_A); }
    expect(h.db.stmts.some((s) => /INSERT\s+INTO\s+core\.event_log/i.test(s.text))).toBe(true);
  });
  it('a forced rollback after assign removes the rejected run AND the event (no autonomous commit of the event)', async () => {
    const h = makeRunHarness();
    await expect(h.transaction(() => h.svc.assign(h.ctx(), draft(1, L1, 3.4, at('08:00:00'))), { rollback: true })).rejects.toThrow('forced rollback');
    expect(h.runs()).toEqual([]);
    expect(h.stored()).toEqual([]);
  });
  it('an event INSERT failure rolls the whole assignment back and surfaces the error: no rejected run without its event, no member', async () => {
    const h = makeRunHarness();
    h.db.fail(/INSERT\s+INTO\s+core\.event_log/i, () => new Error('event log down'));
    const err = await rejection(h.place(draft(1, L1, 3.4, at('08:00:00'))));
    expect(err).toBeInstanceOf(Error);
    expect(h.runs()).toEqual([]);
    expect(h.state.observations).toEqual([]);
    expect(h.stored()).toEqual([]);
  });
  it('a failure of the qc_activity write at completion rolls the member and the evaluation back (nothing half-committed)', async () => {
    const h = makeRunHarness({ hooks: { failOp: { resetQcActivity: new Error('activity down') } } });
    await h.place(draft(1, L1, 1.0, at('08:00:00')));
    const err = await rejection(h.place(draft(2, L2, 0.2, at('08:01:00'))));
    expect(err.message).toBe('activity down');
    expect(h.run(h.runs()[0]!['id'])).toMatchObject({ status: 'collecting', outcome: null, observation_count: 1 });
    expect(h.state.observations).toHaveLength(1);
  });
  it('closeStaleRuns: the rejection event rolls back with the stale close', async () => {
    const h = makeRunHarness();
    const r = h.seedRun(1, { last_assembled_at: at('08:00:05'), observation_count: 1 });
    h.seedMember(r['id'], 1, L1, 3.4, at('08:00:00'));
    await expect(h.transaction(() => h.svc.closeStaleRuns(h.ctx({ now: () => at('09:00:00') })), { rollback: true })).rejects.toThrow('forced rollback');
    expect(h.run(r['id'])).toMatchObject({ status: 'collecting', outcome: null });
    expect(h.stored()).toEqual([]);
  });
});

describe('pair lock (TRD §7.3 "pair locked"; 03-APP-FLOW §3.1 "lock qc_plans(pair) FOR UPDATE")', () => {
  it('assign takes the plan lock first: lockPlan(tx, tenant, plan_id) precedes every other repo call', async () => {
    const h = makeRunHarness();
    await h.place(draft(1, L1, 0.5, at('08:00:00')));
    expect(h.calls[0]).toMatchObject({ op: 'lockPlan', tenantId: TENANT_A, args: [PLN(1)] });
  });
  it('two concurrent transactions for the same pair serialise: both members end in ONE run, no duplicate collecting run, no unique-index error', async () => {
    const h = makeRunHarness();
    const tx = () => Object.create(h.db.tx);
    const t1 = tx(), t2 = tx();
    const one = (t: any, d: any) => h.svc.assign(h.ctx({ tx: t }), d).then((r) => { h.state.observations.push({ ...d, qc_run_id: r.qc_run_id, status: 'assigned' }); h.commit(t); return r.qc_run_id; });
    const [a, b] = await Promise.all([one(t1, draft(1, L1, 0.4, at('08:00:00'))), one(t2, draft(2, L2, 0.2, at('08:01:00')))]);
    expect(a).toBe(b);
    expect(h.runs()).toHaveLength(1);
    expect(h.run(a)).toMatchObject({ observation_count: 2, status: 'evaluated', outcome: 'accepted', is_complete: true });
  });
  it('different pairs do not block each other (the lock is per plan)', async () => {
    const h = makeRunHarness();
    const t1 = Object.create(h.db.tx);
    await h.repo.lockPlan(t1, TENANT_A, PLN(1));                          // t1 holds pair 1 and never commits
    const d9 = draft(1, L1, 0.4, at('08:00:00'), { plan_id: PLN(9), instrument_id: INS(2), analyte_id: ANA(2) });
    await expect(Promise.race([h.svc.assign(h.ctx(), d9), new Promise((_, rej) => setTimeout(() => rej(new Error('blocked on another pair')), 500))])).resolves.toMatchObject({ qc_run_id: expect.any(String) });
  });
});

describe('qc_activity reset (QR4; 03-APP-FLOW §3.1 "accepted / warning -> qc_activity reset")', () => {
  const seedActivity = (h: ReturnType<typeof makeRunHarness>) => h.state.activity.push({ tenant_id: TENANT_A, plan_id: PLN(1), last_qc_run_at: at('06:00:00'), patient_results_since_last_qc: 7, last_patient_result_at: at('07:30:00') });
  it('an accepted complete run sets last_qc_run_at = run_at and patient_results_since_last_qc = 0 (last_patient_result_at untouched)', async () => {
    const h = makeRunHarness(); seedActivity(h);
    await h.place(draft(1, L1, 0.5, at('08:00:00')));
    expect(h.state.activity[0]).toMatchObject({ last_qc_run_at: at('06:00:00'), patient_results_since_last_qc: 7 });   // still collecting: no reset yet
    await h.place(draft(2, L2, 0.1, at('08:02:00')));
    expect(h.state.activity[0]).toMatchObject({ last_qc_run_at: at('08:00:00'), patient_results_since_last_qc: 0, last_patient_result_at: at('07:30:00') });
    expect(h.callsOf('resetQcActivity')[0]!.args).toEqual([PLN(1), at('08:00:00')]);
  });
  it('accepted_warning resets too', async () => {
    const h = makeRunHarness(); seedActivity(h);
    await h.place(draft(1, L1, 2.5, at('08:00:00')));
    await h.place(draft(2, L2, 0.1, at('08:02:00')));
    expect(h.state.activity[0]).toMatchObject({ last_qc_run_at: at('08:00:00'), patient_results_since_last_qc: 0 });
  });
  it('rejected (early or complete) and incomplete outcomes do not reset it', async () => {
    const h = makeRunHarness(); seedActivity(h);
    await h.place(draft(1, L1, 3.4, at('08:00:00')));                        // early rejected
    await h.place(draft(2, L1, 0.5, at('09:00:00'), { received_at: at('09:00:00') }));   // new run
    h.at(at('09:40:00'));
    await h.svc.closeStaleRuns(h.ctx());                                       // incomplete
    expect(h.state.activity[0]).toMatchObject({ last_qc_run_at: at('06:00:00'), patient_results_since_last_qc: 7 });
    expect(h.callsOf('resetQcActivity')).toEqual([]);
  });
});

describe('close_stale_runs (TRD §7.3 step 7; AC-06.7; AS4; QR5)', () => {
  const open = (h: ReturnType<typeof makeRunHarness>, assembledAt = at('08:00:05')) => { const r = h.seedRun(1, { last_assembled_at: assembledAt, observation_count: 1 }); h.seedMember(r['id'], 1, L1, 0.5, at('08:00:00')); return r; };

  it('AC-06.7: a run with no new member for more than run_window_minutes is finalised incomplete (is_complete false, evaluated_at = ctx.now(), no event)', async () => {
    const h = makeRunHarness(); const r = open(h);
    const res = await h.svc.closeStaleRuns(h.ctx({ now: () => at('08:30:06') }));
    expect(h.run(r['id'])).toMatchObject({ status: 'evaluated', outcome: 'incomplete', is_complete: false, observation_count: 1, evaluated_at: at('08:30:06'), evaluated_by: SYSTEM, rules_violated: [] });
    expect(res).toMatchObject({ closed: 1, rejected: 0 });
    expect(h.stored()).toEqual([]);
  });
  it('staleness is strict: last_assembled_at exactly run_window_minutes ago is not stale; one millisecond more is', async () => {
    const h = makeRunHarness(); const r = open(h);
    expect(await h.svc.closeStaleRuns(h.ctx({ now: () => at('08:30:05') }))).toMatchObject({ closed: 0 });
    expect(h.run(r['id'])['status']).toBe('collecting');
    expect(await h.svc.closeStaleRuns(h.ctx({ now: () => '2026-11-13T08:30:05.001Z' }))).toMatchObject({ closed: 1 });
  });
  it('AS4: backlog — L1 observed/received 02:00 assembled at 08:00; close_stale at 08:05 leaves it collecting; L2 observed 02:02 processed at 08:06 joins: ONE complete run', async () => {
    const h = makeRunHarness({ now: at('08:00:00') });
    const id = await h.place(draft(1, L1, 0.4, at('02:00:00'), { received_at: at('02:00:00') }));
    expect(h.run(id)).toMatchObject({ run_at: at('02:00:00'), last_assembled_at: at('08:00:00') });
    h.at(at('08:05:00'));
    expect(await h.svc.closeStaleRuns(h.ctx())).toMatchObject({ closed: 0 });
    expect(h.run(id)['status']).toBe('collecting');
    h.at(at('08:06:00'));
    expect(await h.place(draft(2, L2, 0.2, at('02:02:00'), { received_at: at('02:02:00') }))).toBe(id);
    expect(h.runs()).toHaveLength(1);
    expect(h.run(id)).toMatchObject({ status: 'evaluated', outcome: 'accepted', is_complete: true, observation_count: 2 });
  });
  it('staleness uses last_assembled_at (server time), never run_at: an old run_at with a fresh assembly stays open; a fresh run_at with an old assembly closes', async () => {
    const h = makeRunHarness();
    const fresh = h.seedRun(1, { run_at: at('02:00:00'), last_member_received_at: at('02:00:00'), last_assembled_at: at('08:20:00'), observation_count: 1 });
    h.seedMember(fresh['id'], 1, L1, 0.5, at('02:00:00'));
    const old = h.seedRun(2, { plan_id: PLN(9), instrument_id: INS(2), analyte_id: ANA(2), run_at: at('09:00:00'), last_assembled_at: at('08:00:00'), observation_count: 1 });
    h.seedMember(old['id'], 2, L1, 0.5, at('09:00:00'), { plan_id: PLN(9) });
    await h.svc.closeStaleRuns(h.ctx({ now: () => at('08:40:00') }));
    expect(h.run(fresh['id'])['status']).toBe('collecting');
    expect(h.run(old['id'])).toMatchObject({ status: 'evaluated', outcome: 'incomplete' });
  });
  it('a stale run whose members now reject is finalised rejected: ONE event with the §7.7 payload (stale close is an event trigger, TRD §10.1)', async () => {
    const h = makeRunHarness();
    const r = h.seedRun(1, { run_at: D('06:00:00'), last_assembled_at: D('06:00:05'), observation_count: 1 });
    h.seedMember(r['id'], 1, L1, 3.4, D('06:00:00'));
    const res = await h.svc.closeStaleRuns(h.ctx({ now: () => D('07:00:00') }));
    expect(res).toMatchObject({ closed: 1, rejected: 1 });
    expect(h.run(r['id'])).toMatchObject({ status: 'evaluated', outcome: 'rejected', is_complete: false, rules_violated: ['1-3s'], hold_since: at('06:00:00', '2026-11-04'), evaluated_at: D('07:00:00') });
    expect(h.stored()).toHaveLength(1);
    expect(h.stored()[0]!.key).toBe(`${r['id']}:rejected`);
    expect(h.stored()[0]!.envelope.payload).toMatchObject({ rejected_at: D('07:00:00'), rules_violated: ['1-3s'], run_at: D('06:00:00') });
  });
  it('a 1-2s on an incomplete run is kept in warning_rules; the outcome is incomplete and nothing is published', async () => {
    const h = makeRunHarness();
    const r = h.seedRun(1, { observation_count: 1 }); h.seedMember(r['id'], 1, L1, 2.5, at('08:00:00'));
    await h.svc.closeStaleRuns(h.ctx({ now: () => at('09:00:00') }));
    expect(h.run(r['id'])).toMatchObject({ outcome: 'incomplete', warning_rules: ['1-2s'], rules_violated: [] });
    expect(h.stored()).toEqual([]);
  });
  it('the pair lock is taken before the run is re-read, and a run that was refreshed while waiting for the lock is NOT closed', async () => {
    const h = makeRunHarness({ hooks: { onLock: (_p, s) => { s.runs[0]!['last_assembled_at'] = at('08:50:00'); s.runs[0]!['observation_count'] = 2; } } });
    const r = open(h);
    const res = await h.svc.closeStaleRuns(h.ctx({ now: () => at('09:00:00') }));
    expect(res).toMatchObject({ closed: 0 });
    expect(h.run(r['id'])).toMatchObject({ status: 'collecting', observation_count: 2 });
    const ops = h.calls.map((c) => c.op);
    expect(ops.indexOf('lockPlan')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('lockPlan')).toBeLessThan(ops.lastIndexOf('findCollectingRun'));
  });
  it('a run that was evaluated (by assign, evaluate-now) while waiting for the lock is skipped: no error, no second event', async () => {
    const h = makeRunHarness({ hooks: { onLock: (_p, s) => Object.assign(s.runs[0]!, { status: 'evaluated', outcome: 'rejected', is_complete: false, rules_violated: ['1-3s'], hold_since: at('06:00:00'), evaluated_at: at('08:59:00') }) } });
    open(h);
    const res = await h.svc.closeStaleRuns(h.ctx({ now: () => at('09:00:00') }));
    expect(res).toMatchObject({ closed: 0, rejected: 0 });
    expect(h.stored()).toEqual([]);
  });
  it('locks the pairs in ascending plan_id order (no lock-order deadlock between ticks) and only for stale runs', async () => {
    const h = makeRunHarness();
    const a = h.seedRun(1, { plan_id: PLN(9), instrument_id: INS(2), analyte_id: ANA(2), observation_count: 1 }); h.seedMember(a['id'], 1, L1, 0.3, at('08:00:00'), { plan_id: PLN(9) });
    const b = h.seedRun(2, { observation_count: 1 }); h.seedMember(b['id'], 2, L1, 0.3, at('08:00:00'));
    const fresh = h.seedRun(3, { plan_id: idN(0x8100), last_assembled_at: at('08:59:00'), observation_count: 1 });
    h.state.plans.push({ ...h.state.plans[0]!, plan_id: idN(0x8100) });
    await h.svc.closeStaleRuns(h.ctx({ now: () => at('09:00:00') }));
    expect(h.callsOf('lockPlan').map((c) => c.args[0])).toEqual([PLN(1), PLN(9)]);
    expect(h.run(fresh['id'])['status']).toBe('collecting');
  });
  it('is idempotent: a second tick closes nothing and publishes no second event', async () => {
    const h = makeRunHarness();
    const r = h.seedRun(1, { observation_count: 1 }); h.seedMember(r['id'], 1, L1, 3.4, at('08:00:00'));
    await h.svc.closeStaleRuns(h.ctx({ now: () => at('09:00:00') }));
    const again = await h.svc.closeStaleRuns(h.ctx({ now: () => at('09:01:00') }));
    expect(again).toMatchObject({ closed: 0, rejected: 0 });
    expect(h.stored()).toHaveLength(1);
  });
  it('works on the ctx tenant only: another tenant\'s stale run is neither read nor closed', async () => {
    const h = makeRunHarness();
    const other = h.seedRun(1, { tenant_id: TENANT_B, observation_count: 1 });
    const res = await h.svc.closeStaleRuns(h.ctx({ now: () => at('09:00:00') }));
    expect(res).toMatchObject({ closed: 0 });
    expect(h.run(other['id'])['status']).toBe('collecting');
    expect(h.calls.every((c) => c.tenantId === TENANT_A)).toBe(true);
  });
  it('gauge input (TRD §14): oldestRejectedWithoutActionAgeSeconds = ctx.now() - evaluated_at of the oldest rejected run with no corrective action; 0 when there is none; a corrective action removes it', async () => {
    const h = makeRunHarness();
    h.seedPrior(1, 'rejected', at('06:00:00'), { status: 'evaluated' });
    h.seedPrior(2, 'rejected', at('07:00:00'), { plan_id: PLN(9) });
    expect(await h.svc.closeStaleRuns(h.ctx({ now: () => at('10:00:00') }))).toMatchObject({ oldestRejectedWithoutActionAgeSeconds: 14400 });
    h.state.corrective.push({ qc_run_id: RUN(1) });
    expect(await h.svc.closeStaleRuns(h.ctx({ now: () => at('10:00:00') }))).toMatchObject({ oldestRejectedWithoutActionAgeSeconds: 10800 });
    h.state.corrective.push({ qc_run_id: RUN(2) });
    expect(await h.svc.closeStaleRuns(h.ctx({ now: () => at('10:00:00') }))).toMatchObject({ oldestRejectedWithoutActionAgeSeconds: 0 });
  });
});

describe('adversarial / hygiene (07-SECURITY: tenancy, immutability S-09, log hygiene)', () => {
  it('a draft of another tenant is refused before any write', async () => {
    const h = makeRunHarness();
    await rejection(h.svc.assign(h.ctx(), draft(1, L1, 3.4, at('08:00:00'), { tenant_id: TENANT_B })));
    expect(h.runs()).toEqual([]);
    expect(h.stored()).toEqual([]);
    expect(h.calls.filter((c) => c.op === 'insertRun' || c.op === 'updateRun')).toEqual([]);
  });
  it('a plan that cannot be locked (gone / other tenant) fails the assignment without writing a run', async () => {
    const h = makeRunHarness();
    await rejection(h.svc.assign(h.ctx(), draft(1, L1, 0.5, at('08:00:00'), { plan_id: idN(0x8fff) })));
    expect(h.runs()).toEqual([]);
  });
  it('the draft passed in is not mutated (T-09 inserts it afterwards) and the result is only { qc_run_id }', async () => {
    const h = makeRunHarness();
    const d = draft(1, L1, 0.5, at('08:00:00'));
    const before = structuredClone(d);
    const r = await h.svc.assign(h.ctx(), d);
    expect(d).toEqual(before);
    expect(Object.keys(r)).toEqual(['qc_run_id']);
  });
  it('a re-evaluation of an evaluated run is impossible: the frozen columns are never patched (the fake trigger would throw P0001)', async () => {
    const h = makeRunHarness();
    await h.place(draft(1, L1, 3.4, at('08:00:00')));
    for (let i = 2; i < 6; i++) await h.place(draft(i, i % 2 ? L1 : L2, 0.2, at(`08:0${i}:00`)));   // L2 attaches; L1 opens new runs
    expect(h.runs().filter((r) => r['outcome'] === 'rejected')).toHaveLength(1);
    expect(h.stored()).toHaveLength(1);
  });
  it('no QC value, z-score or raw control id reaches the logs', async () => {
    const h = makeRunHarness();
    await h.place(draft(1, L1, 3.4, at('08:00:00'), { control_id_raw: 'RAW-CTRL-SENTINEL-77' }));
    const text = JSON.stringify(h.logs);
    for (const s of ['106.8', '3.400000', 'RAW-CTRL-SENTINEL-77']) expect(text).not.toContain(s);
  });
  it('a stream of 20 members for one pair keeps at most one collecting run and exactly one event (unique key) per rejected run', async () => {
    const h = makeRunHarness();
    for (let i = 0; i < 20; i++) await h.place(draft(100 + i, i % 2 ? L2 : L1, i % 5 === 0 ? 3.5 : 0.1, at(`10:${String(i * 2).padStart(2, '0')}:00`), { received_at: at(`10:${String(i * 2).padStart(2, '0')}:00`) }));
    const collecting = h.runs().filter((r) => r['status'] === 'collecting');
    expect(collecting.length).toBeLessThanOrEqual(1);
    expect(h.stored()).toHaveLength(h.runs().filter((r) => r['outcome'] === 'rejected').length);
    expect(new Set(h.stored().map((e) => e.key)).size).toBe(h.stored().length);
  });
});
