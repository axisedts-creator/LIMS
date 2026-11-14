// C9 T-10 run service: assemble, evaluate, publish (02-TRD §7.3 steps 1-7 + 1a, §7.5, §7.7 H1-H4, §10.1, §14; 03-APP-FLOW §2.1 QR1-QR6; PRD AC-06.6-06.9; 07-SECURITY S-09).
// `assign` IS the T-09 RunAssembler seam: called per `assigned` draft BEFORE the observation insert, on the job tx. The draft is not yet a member, so it is added in memory.
// [CONV] pair lock = repo.lockPlan (FOR UPDATE on the plan row), taken first by every entry point; the caller (T-09) already holds it, a same-tx re-lock is free.
// [CONV] the rejection event is published BEFORE the single UPDATE that freezes the run, with aggregate seq = run.version + 1 (what the UPDATE will make the version), so the run can
//        store rejection_event_id in that same UPDATE and the frozen columns are written once (quality.enforce_run_frozen). The event and the run share ctx.tx: both commit or neither.
// [CONV] clock = ctx.now() only (one reading per operation). No QC value, z-score or raw control id is ever logged.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { parseDecimal, sub } from '../../../../../../packages/shared-ts/src/decimal/index.js';
import { LimsError } from '../../../core/errors.js';
import { createEvents } from '../../../core/events/publish.js';
import { assembleObservation, isCompositionFull, isStale, type AssemblyRun } from '../domain/assembly.js';
import { transitionRun, type RunEvent, type RunState } from '../domain/run.state.js';
import { evaluate, type QcPoint, type WestgardResult } from '../domain/westgard.js';
import { createQualityEvents, type QualityEvents } from '../events/publish.js';
import { createRunRepo, type PlanParams, type Row, type RunRepo } from '../repository/run.repo.js';

export interface RunCtx {
  readonly tenantId: string; readonly actor: { readonly id: string }; readonly tx: any; readonly now: () => string; readonly ports?: any; readonly log?: any;
}
export interface CloseStaleResult { closed: number; rejected: number; oldestRejectedWithoutActionAgeSeconds: number }

const HISTORY_LIMIT = 500;   // newest observations of the plan; the longest rule window is 12 points per level
const HOUR_MS = 3_600_000;
const internal = (): never => { throw new LimsError('common.internal'); };
const ms = (iso: string): number => Date.parse(iso);
const byOrder = (a: Row, b: Row): number => (a['observed_at'] < b['observed_at'] ? -1 : a['observed_at'] > b['observed_at'] ? 1 : a['id'] < b['id'] ? -1 : a['id'] > b['id'] ? 1 : 0);
const latest = (xs: string[]): string => xs.reduce((a, b) => (b > a ? b : a));

export function createRunService(deps: { repo?: RunRepo; events?: QualityEvents } = {}) {
  const repo = deps.repo ?? createRunRepo();
  let defaultEvents: QualityEvents | undefined;
  const events = (): QualityEvents => deps.events ?? (defaultEvents ??= createQualityEvents(createEvents({ producer: 'quality' }) as never));

  const composition = (plan: PlanParams): Record<string, number> => Object.fromEntries(plan.composition.map((c) => [c.level_id, c.count]));
  const levelCounts = (members: Row[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const m of members) out[m['level_id']] = (out[m['level_id']] ?? 0) + 1;
    return out;
  };
  const asAssemblyRun = (r: Row, members: Row[]): AssemblyRun => ({
    id: r['id'], status: r['status'], outcome: r['outcome'], isComplete: r['is_complete'] === true,
    runAt: new Date(r['run_at']), lastAssembledAt: new Date(r['last_assembled_at']), levelCounts: levelCounts(members),
  });
  const toPoint = (m: Row, inCurrentRun: boolean): QcPoint => {
    const value = parseDecimal(String(m['value'])), mean = parseDecimal(String(m['mean'])), sd = parseDecimal(String(m['sd']));
    if (!value || !mean || !sd) return internal();
    return { id: m['id'], level: m['level_id'], dev: sub(value, mean), sd, inCurrentRun };
  };

  /** §7.5 over the run's members (order-key order) and the plan history (oldest first). Options come from the run's snapshots and the locked plan. */
  async function evaluateRun(ctx: RunCtx, plan: PlanParams, run: Row, members: Row[]): Promise<WestgardResult> {
    const history = await repo.listHistory(ctx.tx, ctx.tenantId, plan.plan_id, { excludeRunId: run['id'], excludeRejectedRuns: plan.exclude_rejected_runs_from_history, limit: HISTORY_LIMIT });
    return evaluate(members.map((m) => toPoint(m, true)), history.map((h) => toPoint(h, false)), {
      n: run['controls_per_run'], mode: run['rule_mode'] === 'modern' ? 'modern' : 'classic', meanRule: run['mean_rule'],
      twoTwoAcrossRuns: plan.two_two_s_across_runs, countAcrossMaterials: plan.count_rules_across_materials,
    });
  }

  const detail = (res: WestgardResult): Row[] => res.hits.map((h) => ({ rule: h.rule, observation_ids: [...h.observationIds] }));

  /**
   * Steps 5 / 3 / 7 for one collecting run: QR2 (still collecting), QR3 (rejected early), QR4 (complete), QR5 (final, incomplete or rejected). One UPDATE carries `base` and the evaluation.
   * Returns the updated run, or the run unchanged when nothing was decided and `base` is empty.
   */
  async function settle(ctx: RunCtx, plan: PlanParams, run: Row, members: Row[], mode: 'provisional' | 'final', base: Row, now: string): Promise<Row> {
    const t = ctx.tenantId;
    const res = await evaluateRun(ctx, plan, run, members);
    const full = isCompositionFull(levelCounts(members), composition(plan));
    let ev: RunEvent | null = null;
    if (full) ev = { type: 'complete', outcome: res.outcome };
    else if (res.outcome === 'rejected') ev = mode === 'provisional' ? { type: 'reject_early' } : { type: 'finalize', outcome: 'rejected' };
    else if (mode === 'final') ev = { type: 'finalize', outcome: 'incomplete' };   // a 1-2s stays in warning_rules
    if (ev === null) return Object.keys(base).length === 0 ? run : repo.updateRun(ctx.tx, t, run['id'], { ...base, updated_by: ctx.actor.id });

    const from: RunState = { status: 'collecting', outcome: null, isComplete: false };
    const tr = transitionRun(from, ev);
    const patch: Row = {
      ...base, status: tr.state.status, outcome: tr.state.outcome, is_complete: tr.state.isComplete, rules_violated: [...res.fired], warning_rules: res.warning ? ['1-2s'] : [],
      rule_detail: detail(res), evaluated_at: now, evaluated_by: ctx.actor.id, updated_by: ctx.actor.id,
    };
    if (tr.emitsRejectedEvent) {
      const last = await repo.latestInControlRunAt(ctx.tx, t, plan.plan_id, run['run_at']);   // §7.7: accepted | accepted_warning, run_at < this run, any age
      const holdSince = last ?? new Date(ms(run['run_at']) - plan.hold_lookback_hours * HOUR_MS).toISOString();
      const published = await events().publishQcRunRejected(ctx as never, {
        qc_run_id: run['id'], instrument_id: run['instrument_id'], analyte_ids: [run['analyte_id']], rules_violated: [...res.fired], rule_mode: run['rule_mode'], controls_per_run: run['controls_per_run'],
        run_at: run['run_at'], ...(last === undefined ? {} : { last_in_control_run_at: last }), hold_since: holdSince, rejected_at: now,
      }, { runVersion: run['version'] + 1 });
      Object.assign(patch, { last_in_control_run_at: last ?? null, hold_since: holdSince, rejection_event_id: published.eventId });
    }
    const updated = await repo.updateRun(ctx.tx, t, run['id'], patch);
    if (tr.transition === 'QR4' && (tr.state.outcome === 'accepted' || tr.state.outcome === 'accepted_warning')) await repo.resetQcActivity(ctx.tx, t, plan.plan_id, run['run_at']);
    return updated;
  }

  async function readMode(ctx: RunCtx): Promise<'classic' | 'modern'> {
    const s = await ctx.ports?.IdentityPort?.getTenantSettings?.(ctx, { keys: ['westgardMode'] });
    return s?.westgardMode === 'modern' ? 'modern' : 'classic';   // D-QC-1: no value = classic
  }

  async function assign(ctx: RunCtx, draft: Row): Promise<{ qc_run_id: string }> {
    const t = ctx.tenantId;
    if (draft['tenant_id'] !== t || typeof draft['plan_id'] !== 'string' || typeof draft['level_id'] !== 'string' || typeof draft['observed_at'] !== 'string' || typeof draft['received_at'] !== 'string') return internal();
    const plan = await repo.lockPlan(ctx.tx, t, draft['plan_id']);   // pair lock: first statement
    if (!plan) return internal();
    const now = ctx.now();
    const mine: Row = { id: draft['id'], level_id: draft['level_id'], value: draft['value'], mean: draft['mean'], sd: draft['sd'], observed_at: draft['observed_at'], received_at: draft['received_at'] };
    const withDraft = (members: Row[]): Row[] => [...members, mine].sort(byOrder);
    const joined = (run: Row, members: Row[]): Row => ({ observation_count: members.length, last_member_received_at: latest([...members.map((m) => m['received_at']), run['last_member_received_at']]), last_assembled_at: now });

    const collecting = await repo.findCollectingRun(ctx.tx, t, plan.plan_id);
    const collectingMembers = collecting ? await repo.listRunMembers(ctx.tx, t, collecting['id']) : [];
    const early = collecting ? undefined : await repo.findLatestEarlyRejectedRun(ctx.tx, t, plan.plan_id);
    const earlyMembers = early ? await repo.listRunMembers(ctx.tx, t, early['id']) : [];
    const decision = assembleObservation({
      observation: { id: draft['id'], level: draft['level_id'], observedAt: new Date(draft['observed_at']) },
      collecting: collecting ? asAssemblyRun(collecting, collectingMembers) : null, latestEarlyRejected: early ? asAssemblyRun(early, earlyMembers) : null,
      composition: composition(plan), runWindowMinutes: plan.run_window_minutes,
    });

    if (decision.action === 'attach_collecting') {   // step 2 + 5
      const members = withDraft(collectingMembers);
      await settle(ctx, plan, collecting!, members, 'provisional', joined(collecting!, members), now);
      return { qc_run_id: collecting!['id'] };
    }
    if (decision.action === 'attach_early_rejected') {   // step 1a / QR6: stored and linked, rule hits recorded, outcome / rules_violated / is_complete / event frozen
      transitionRun({ status: 'evaluated', outcome: 'rejected', isComplete: false }, { type: 'attach_late_member' });
      const members = withDraft(earlyMembers);
      const res = await evaluateRun(ctx, plan, early!, members);
      const known = new Set((early!['rule_detail'] as Row[]).map((d) => JSON.stringify(d)));
      const added = detail(res).filter((d) => (d['observation_ids'] as string[]).includes(draft['id'])).filter((d) => !known.has(JSON.stringify(d)));
      await repo.updateRun(ctx.tx, t, early!['id'], { ...joined(early!, members), ...(added.length ? { rule_detail: [...early!['rule_detail'], ...added] } : {}), updated_by: ctx.actor.id });
      return { qc_run_id: early!['id'] };
    }
    if (decision.finalizeRunId !== null) await settle(ctx, plan, collecting!, collectingMembers, 'final', {}, now);   // step 3: the old run ends before the new one opens (partial unique index)

    const run: Row = {   // step 4 / QR1
      id: uuidv7(), tenant_id: t, plan_id: plan.plan_id, plan_version_no: plan.version_no, instrument_id: plan.instrument_id, analyte_id: plan.analyte_id, controls_per_run: plan.controls_per_run,
      rule_mode: await readMode(ctx), mean_rule: plan.mean_rule, run_at: draft['observed_at'], last_member_received_at: draft['received_at'], last_assembled_at: now, observation_count: 1,
      status: 'collecting', outcome: null, is_complete: null, rules_violated: [], warning_rules: [], rule_detail: [], evaluated_at: null, evaluated_by: null, last_in_control_run_at: null,
      hold_since: null, rejection_event_id: null, closed_at: null, closed_by: null, version: 1, created_at: now, created_by: ctx.actor.id, updated_at: now, updated_by: ctx.actor.id,
    };
    await repo.insertRun(ctx.tx, t, run);
    await settle(ctx, plan, run, [mine], 'provisional', {}, now);   // step 5: an early rejection finalises at once
    return { qc_run_id: run['id'] };
  }

  /** §7.3 step 7: finalise every collecting run whose last_assembled_at is strictly older than now - run_window_minutes. Pair locks in ascending plan_id order, the run re-read under the lock. */
  async function closeStaleRuns(ctx: RunCtx): Promise<CloseStaleResult> {
    const t = ctx.tenantId;
    const now = ctx.now(), nowMs = ms(now);
    const stale = (await repo.listCollectingRuns(ctx.tx, t))
      .filter((r) => isStale({ status: r['status'], lastAssembledAt: new Date(r['last_assembled_at']) }, new Date(nowMs), r['run_window_minutes']));
    const planIds = [...new Set(stale.map((r) => r['plan_id'] as string))].sort();
    const out: CloseStaleResult = { closed: 0, rejected: 0, oldestRejectedWithoutActionAgeSeconds: 0 };
    for (const planId of planIds) {
      const plan = await repo.lockPlan(ctx.tx, t, planId);
      if (!plan) continue;
      const run = await repo.findCollectingRun(ctx.tx, t, planId);   // under the lock: assign / evaluate-now may have moved it meanwhile
      if (!run || !isStale({ status: run['status'], lastAssembledAt: new Date(run['last_assembled_at']) }, new Date(nowMs), plan.run_window_minutes)) continue;
      const done = await settle(ctx, plan, run, await repo.listRunMembers(ctx.tx, t, run['id']), 'final', {}, now);
      out.closed++;
      if (done['outcome'] === 'rejected') out.rejected++;
    }
    const oldest = await repo.oldestRejectedWithoutActionAt(ctx.tx, t);
    out.oldestRejectedWithoutActionAgeSeconds = oldest === undefined ? 0 : Math.max(0, Math.floor((nowMs - ms(oldest)) / 1000));
    if (out.closed > 0) ctx.log?.info?.({ event: 'quality_close_stale_runs', closed: out.closed, rejected: out.rejected });
    return out;
  }

  /**
   * QR5 via #30 (T-12): finalise the plan's COLLECTING run on staff request, exactly like close_stale_runs (mode 'final': incomplete, or rejected + event in the same tx).
   * Pair lock first; the collecting run is re-read UNDER the lock, and anything but `runId` (already evaluated, closed, another run collecting, none) is refused.
   * evaluated_by = ctx.actor.id (the staff user), evaluated_at = ctx.now().
   */
  async function evaluateNow(ctx: RunCtx, input: { runId: string; planId: string }): Promise<Row> {
    const t = ctx.tenantId;
    const plan = await repo.lockPlan(ctx.tx, t, input.planId);
    if (!plan) throw new LimsError('common.not_found');
    const run = await repo.findCollectingRun(ctx.tx, t, input.planId);
    if (!run || run['id'] !== input.runId) throw new LimsError('quality.qc_run_already_evaluated');
    return settle(ctx, plan, run, await repo.listRunMembers(ctx.tx, t, run['id']), 'final', {}, ctx.now());
  }

  return { assign, closeStaleRuns, evaluateNow };
}
export type RunService = ReturnType<typeof createRunService>;
