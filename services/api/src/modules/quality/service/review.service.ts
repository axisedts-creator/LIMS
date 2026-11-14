// C9 T-12 runs read + review actions #26-#33 (02-TRD §5.5, §5.10, §7.7; 03-APP-FLOW QR5/QR7; AC-07.1-07.5; 07-SECURITY S-01/S-03/S-09/S-10/S-16, AB-02, AB-10, REQ-SEC-100).
// Order of every write: assertRole -> id syntax (404) -> validate body (400) -> (If-Match present? 428) -> load through the tenant-scoped repo (404) -> version check (409) -> state / guards (409) -> write.
// Tenant, actor, membership and ids come from ctx / the service, never from a body. Clock = ctx.now(). The service opens no transaction: every repo call gets ctx.tx.
// [CONV] reads without both bounds are still bounded: the window ends at ctx.now() and starts 92 days earlier (REQ-SEC-100; an unbounded read is impossible).
// [CONV] close = runRepo.lockPlan (pair lock) -> re-read the run -> guards (corrective action first, then a later accepted run, D-52) -> ONE runRepo.updateRun {status, closed_at, closed_by, updated_by}.
// [CONV] a corrective action needs an evaluated REJECTED run: a closed run is frozen (common.immutable_record).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, isLimsError } from '../../../core/errors.js';
import { assertRunAction, transitionRun } from '../domain/run.state.js';
import { correctiveActionDto, observationDto, observationUserIds, reviewDto, runDto, runLabelIds, runSummaryDto } from '../mappers/review.mapper.js';
import { createReviewRepo, type ReviewRepo } from '../repository/review.repo.js';
import { createRunRepo, type RunRepo } from '../repository/run.repo.js';
import type { Row } from '../repository/setup.repo.js';
import { createRunService, type RunCtx } from './run.service.js';
import { shape } from './plan.service.js';
import type { Result } from './setup.service.js';
import { Errs, isUuid, paging, qBool, qEnum, qUuid } from './setup.validate.js';

export interface ReviewCtx {
  readonly tenantId: string; readonly actor: { readonly id: string; readonly membershipId?: string }; readonly tx: any; readonly now: () => string; readonly ports?: any; readonly log?: any;
}
type Obj = Record<string, any>;

const READ = 'quality.qc_run.read', REVIEW = 'quality.qc_run.review', MANAGE = 'quality.qc.manage';
const SPAN_MS = 92 * 86_400_000;                  // 02-TRD §5.5 #26 / #28 [CONV]
const SKEW_MS = 5 * 60_000, BACK_MS = 24 * 3_600_000;   // performed_at: <= now + 5 min, >= run_at - 24 h (inclusive)
const OBS_STATUSES = ['assigned', 'unmapped_analyte', 'non_numeric', 'no_plan', 'unmapped_control', 'level_not_in_plan', 'lot_expired', 'no_target', 'unit_mismatch', 'late_unassigned', 'excluded'];
const RUN_STATUSES = ['collecting', 'evaluated', 'closed'], OUTCOMES = ['accepted', 'accepted_warning', 'incomplete', 'rejected'];
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;   // _common.yaml IsoUtc
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;                                       // _common.yaml Code

const assert = (ctx: ReviewCtx, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const notFound = () => new LimsError('common.not_found');
const conflict = () => new LimsError('common.version_conflict');
const needVersion = (v: number | undefined): number => { if (v === undefined) throw new LimsError('common.precondition_required'); return v; };
const isoUtc = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const text = (e: Errs, o: Obj, k: string, min: number, max: number, required: boolean): string | undefined => {
  const v = o[k];
  if (v === undefined) { if (required) e.add(`/${k}`, 'common.field_required'); return undefined; }
  if (typeof v !== 'string' || [...v].length < min || [...v].length > max) { e.add(`/${k}`); return undefined; }
  return v;
};
const codeField = (e: Errs, o: Obj, k: string): string | undefined => {
  const v = o[k];
  if (v === undefined) { e.add(`/${k}`, 'common.field_required'); return undefined; }
  if (typeof v !== 'string' || !CODE.test(v)) { e.add(`/${k}`); return undefined; }
  return v;
};
const csv = (e: Errs, q: Obj, k: string, allowed: readonly string[]): string[] | undefined => {
  const v = q[k];
  if (v === undefined) return undefined;
  const parts = typeof v === 'string' ? v.split(',') : undefined;
  if (!parts || parts.some((p) => !allowed.includes(p))) { e.add(`/${k}`); return undefined; }
  return parts;
};
const field = (path: string): never => { const e = new Errs(); e.add(path); e.done(); throw e; };

/** The 92-day window of #26 / #28: both bounds -> checked and passed through; one bound -> the other is +/- 92 d; none -> now - 92 d .. now. Errors are reported at the `_to` parameter. */
function span(e: Errs, ctx: ReviewCtx, q: Obj, fromKey: string, toKey: string, fromPath: string, toPath: string): { from: string; to: string } {
  const read = (k: string, p: string): number | undefined => { const v = q[k]; if (v === undefined) return undefined; if (!isoUtc(v)) { e.add(p); return undefined; } return Date.parse(v); };
  const f = read(fromKey, fromPath), t = read(toKey, toPath);
  let from: number, to: number;
  if (f !== undefined && t !== undefined) { if (t < f || t - f > SPAN_MS) e.add(toPath); from = f; to = t; }
  else if (f !== undefined) { from = f; to = f + SPAN_MS; }
  else if (t !== undefined) { to = t; from = t - SPAN_MS; }
  else { to = Date.parse(ctx.now()); from = to - SPAN_MS; }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Postgres -> API: the trigger backstops (P0001 immutable_row) are 409s; anything else fails closed without the driver message. */
function mapWriteError(err: any, onImmutable: string): Error {
  if (isLimsError(err)) return err;
  if (err?.code === 'P0001' && err?.message === 'immutable_row') return new LimsError(onImmutable);
  if (err?.code === 'quality.qc_run_already_evaluated') return new LimsError('quality.qc_run_already_evaluated');   // a delegate that lost the race
  return new LimsError('common.internal');
}

export function createReviewService(deps: { repo?: ReviewRepo; runRepo?: RunRepo; runs?: { evaluateNow(ctx: RunCtx, i: { runId: string; planId: string }): Promise<Row> } } = {}) {
  const repo = deps.repo ?? createReviewRepo();
  const runRepo = deps.runRepo ?? createRunRepo();
  let defaultRuns: ReturnType<typeof createRunService> | undefined;
  const runs = (): NonNullable<typeof deps.runs> => deps.runs ?? (defaultRuns ??= createRunService());

  async function userLabels(ctx: ReviewCtx, ids: string[]): Promise<Map<string, string>> {
    return new Map((ids.length ? await repo.listUserLabels(ctx.tx, ctx.tenantId, ids) : []).map((l) => [l.user_id, l.display_name]));
  }
  async function memberLabels(ctx: ReviewCtx, ids: string[]): Promise<Map<string, string>> {
    return new Map((ids.length ? await repo.listMembershipLabels(ctx.tx, ctx.tenantId, ids) : []).map((l) => [l.membership_id, l.display_name]));
  }
  function membership(ctx: ReviewCtx): string {
    const m = ctx.actor.membershipId;
    if (typeof m !== 'string') throw new LimsError('common.internal');   // a staff action needs the actor's membership; fail closed
    return m;
  }

  /** QcRunDto of one run (observations, corrective actions, reviews, labels). */
  async function runBody(ctx: ReviewCtx, runId: string): Promise<{ row: Row; body: Row }> {
    const row = await repo.findRun(ctx.tx, ctx.tenantId, runId);
    if (!row) throw notFound();
    const observations = await repo.listRunObservations(ctx.tx, ctx.tenantId, runId);
    const correctives = await repo.listCorrectiveActions(ctx.tx, ctx.tenantId, runId);
    const reviews = await repo.listReviews(ctx.tx, ctx.tenantId, runId);
    const ids = runLabelIds(row, observations, correctives, reviews);
    const [users, members] = [await userLabels(ctx, ids.users), await memberLabels(ctx, ids.members)];
    return { row, body: runDto(row, { observations, correctives, reviews, users, members }) };
  }

  async function loadRun(ctx: ReviewCtx, runId: unknown): Promise<Row> {
    const row = isUuid(runId) ? await repo.findRun(ctx.tx, ctx.tenantId, runId) : undefined;
    if (!row) throw notFound();
    return row;
  }
  const runState = (r: Row) => ({ status: r['status'], outcome: r['outcome'] ?? null, isComplete: r['is_complete'] === true });

  /** One append-only review row for the actor (kind fixed by the endpoint). */
  async function review(ctx: ReviewCtx, runId: string, kind: 'acknowledge' | 'evaluate_now' | 'close', comment: string | undefined): Promise<Row> {
    try {
      return await repo.insertReview(ctx.tx, ctx.tenantId, {
        id: uuidv7(), qc_run_id: runId, kind, comment: comment ?? null, reviewed_by_membership_id: membership(ctx), created_at: ctx.now(), created_by: ctx.actor.id,
      });
    } catch (err) { throw mapWriteError(err, 'common.immutable_record'); }
  }
  const commentOnly = (body: unknown): string | undefined => {
    const e = new Errs(), o = shape(e, body ?? {}, ['comment']);
    const c = o ? text(e, o, 'comment', 0, 500, false) : undefined;
    e.done();
    return c;
  };

  return {
    /** #26 */
    async listQcObservations(ctx: ReviewCtx, q: Obj = {}): Promise<Result> {
      await assert(ctx, READ);
      const e = new Errs(), pg = paging(e, q);
      const planId = qUuid(e, q, 'planId', 'plan_id'), instrumentId = qUuid(e, q, 'instrumentId', 'instrument_id'), analyteId = qUuid(e, q, 'analyteId', 'analyte_id');
      const levelId = qUuid(e, q, 'levelId', 'level_id'), lotId = qUuid(e, q, 'lotId', 'lot_id');
      const statuses = csv(e, q, 'status', OBS_STATUSES), sort = qEnum(e, q, 'sort', ['-observed_at', 'observed_at'] as const);
      const win = span(e, ctx, q, 'observedAtFrom', 'observedAtTo', '/observed_at_from', '/observed_at_to');
      e.done();
      const page = await repo.listObservations(ctx.tx, ctx.tenantId, {
        ...(planId !== undefined ? { planId } : {}), ...(instrumentId !== undefined ? { instrumentId } : {}), ...(analyteId !== undefined ? { analyteId } : {}),
        ...(levelId !== undefined ? { levelId } : {}), ...(lotId !== undefined ? { lotId } : {}), ...(statuses !== undefined ? { statuses } : {}), ...win, sort, ...pg,
      });
      const users = await userLabels(ctx, observationUserIds(page.rows));
      return { status: 200, body: { data: page.rows.map((r) => observationDto(r, users)), page: { limit: pg.limit, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) } } };
    },

    /** #27: only while the observation's run is collecting (or it has none) — S-10, AB-02. The service check precedes the write; trigger quality.enforce_observation_exclusion backs it. */
    async excludeQcObservation(ctx: ReviewCtx, i: { observationId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      if (!isUuid(i.observationId)) throw notFound();
      const e = new Errs(), o = shape(e, i.body, ['reason_code', 'comment']);
      const reason = o ? codeField(e, o, 'reason_code') : undefined, comment = o ? text(e, o, 'comment', 0, 500, false) : undefined;
      e.done();
      const known = await repo.findCode(ctx.tx, ctx.tenantId, 'exclusion_reasons', reason!);
      if (!known || !known.is_active) field('/reason_code');
      const expected = needVersion(i.expectedVersion);
      const cur = await repo.findObservation(ctx.tx, ctx.tenantId, i.observationId);
      if (!cur) throw notFound();
      if (cur['version'] !== expected) throw conflict();
      if (cur['run_status'] != null) assertRunAction({ status: cur['run_status'], outcome: null, isComplete: false }, 'exclude_observation');   // evaluated / closed -> 409 quality.qc_run_already_evaluated
      let row: Row | undefined;
      try {
        row = await repo.excludeObservation(ctx.tx, ctx.tenantId, cur['id'], expected, {
          excluded_reason_code: reason!, excluded_comment: comment ?? null, excluded_by: ctx.actor.id, excluded_at: ctx.now(), updated_by: ctx.actor.id,
        });
      } catch (err) { throw mapWriteError(err, 'quality.qc_run_already_evaluated'); }
      if (!row) throw conflict();
      return { status: 200, version: row['version'], body: observationDto(row, await userLabels(ctx, observationUserIds([row]))) };
    },

    /** #28 */
    async listQcRuns(ctx: ReviewCtx, q: Obj = {}): Promise<Result> {
      await assert(ctx, READ);
      const e = new Errs(), pg = paging(e, q);
      const planId = qUuid(e, q, 'planId', 'plan_id'), instrumentId = qUuid(e, q, 'instrumentId', 'instrument_id'), analyteId = qUuid(e, q, 'analyteId', 'analyte_id');
      const statuses = csv(e, q, 'status', RUN_STATUSES), outcomes = csv(e, q, 'outcome', OUTCOMES), needsAction = qBool(e, q, 'needsAction', 'needs_action');
      qEnum(e, q, 'sort', ['-run_at'] as const);
      const win = span(e, ctx, q, 'runAtFrom', 'runAtTo', '/run_at_from', '/run_at_to');
      e.done();
      const page = await repo.listRuns(ctx.tx, ctx.tenantId, {
        ...(planId !== undefined ? { planId } : {}), ...(instrumentId !== undefined ? { instrumentId } : {}), ...(analyteId !== undefined ? { analyteId } : {}),
        ...(statuses !== undefined ? { statuses } : {}), ...(outcomes !== undefined ? { outcomes } : {}), ...(needsAction !== undefined ? { needsAction } : {}), ...win, ...pg,
      });
      return { status: 200, body: { data: page.rows.map(runSummaryDto), page: { limit: pg.limit, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) } } };
    },

    /** #29 */
    async getQcRun(ctx: ReviewCtx, i: { runId: unknown }): Promise<Result> {
      await assert(ctx, READ);
      if (!isUuid(i.runId)) throw notFound();
      const { row, body } = await runBody(ctx, i.runId);
      return { status: 200, version: row['version'], body };
    },

    /** #30 (QR5): finalise the COLLECTING run through the run service (pair lock inside), then one `evaluate_now` review. */
    async evaluateQcRunNow(ctx: ReviewCtx, i: { runId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, REVIEW);
      if (!isUuid(i.runId)) throw notFound();
      const comment = commentOnly(i.body), expected = needVersion(i.expectedVersion);
      const cur = await loadRun(ctx, i.runId);
      if (cur['version'] !== expected) throw conflict();
      if (cur['status'] !== 'collecting') throw new LimsError('quality.qc_run_already_evaluated');
      try { await runs().evaluateNow(ctx as RunCtx, { runId: cur['id'], planId: cur['plan_id'] }); } catch (err) { throw mapWriteError(err, 'quality.qc_run_already_evaluated'); }
      await review(ctx, cur['id'], 'evaluate_now', comment);
      const { row, body } = await runBody(ctx, cur['id']);
      return { status: 200, version: row['version'], body };
    },

    /** #31 (AC-07.1): append-only corrective action on a REJECTED run; performed_at within [run_at - 24 h, now + 5 min]. */
    async recordCorrectiveAction(ctx: ReviewCtx, i: { runId: unknown; body: unknown }): Promise<Result> {
      await assert(ctx, REVIEW);
      if (!isUuid(i.runId)) throw notFound();
      const e = new Errs(), o = shape(e, i.body, ['action_code', 'description', 'performed_at']);
      const action = o ? codeField(e, o, 'action_code') : undefined, description = o ? text(e, o, 'description', 1, 1000, true) : undefined;
      let performed: string | undefined;
      if (o) { if (o['performed_at'] === undefined) e.add('/performed_at', 'common.field_required'); else if (!isoUtc(o['performed_at'])) e.add('/performed_at'); else performed = o['performed_at']; }
      e.done();
      const cur = await loadRun(ctx, i.runId);
      const known = await repo.findCode(ctx.tx, ctx.tenantId, 'corrective_actions', action!);
      if (!known || !known.is_active) field('/action_code');
      const at = Date.parse(performed!);
      if (at > Date.parse(ctx.now()) + SKEW_MS || at < Date.parse(cur['run_at']) - BACK_MS) field('/performed_at');
      if (cur['status'] !== 'evaluated' || cur['outcome'] !== 'rejected') throw new LimsError('common.immutable_record');
      const member = membership(ctx);
      let row: Row;
      try {
        row = await repo.insertCorrectiveAction(ctx.tx, ctx.tenantId, {
          id: uuidv7(), qc_run_id: cur['id'], action_code: action, description, performed_at: performed, performed_by_membership_id: member, created_at: ctx.now(), created_by: ctx.actor.id,
        });
      } catch (err) { throw mapWriteError(err, 'common.immutable_record'); }
      const members = await memberLabels(ctx, [member]);
      return { status: 201, body: correctiveActionDto({ ...row, action_display: known!.display }, members) };
    },

    /** #32 (QR7, AC-07.2-07.4, D-52): close a rejected run once a corrective action exists AND an accepted run came later than R.run_at + run_window_minutes. */
    async closeQcRun(ctx: ReviewCtx, i: { runId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, REVIEW);
      if (!isUuid(i.runId)) throw notFound();
      const comment = commentOnly(i.body), expected = needVersion(i.expectedVersion);
      const first = await loadRun(ctx, i.runId);
      if (first['version'] !== expected) throw conflict();
      const frozen = (r: Row) => { if (r['status'] !== 'evaluated' || r['outcome'] !== 'rejected') throw new LimsError('common.immutable_record'); };
      frozen(first);
      if (!(await runRepo.lockPlan(ctx.tx, ctx.tenantId, first['plan_id']))) throw notFound();   // pair lock BEFORE the guards: no accepted run can slip in or out meanwhile
      const cur = await repo.findRun(ctx.tx, ctx.tenantId, first['id']);                           // re-read under the lock
      if (!cur) throw notFound();
      frozen(cur);
      if (cur['version'] !== expected) throw conflict();
      const count = Number(cur['corrective_action_count'] ?? 0);
      const threshold = new Date(Date.parse(cur['run_at']) + Number(cur['run_window_minutes']) * 60_000).toISOString();
      const later = count >= 1 && (await repo.hasLaterAcceptedRun(ctx.tx, ctx.tenantId, cur['plan_id'], threshold));
      transitionRun(runState(cur), { type: 'close', correctiveActionCount: count, laterAcceptedRunAfterWindow: later });   // QR7; refuses corrective_action_required, then rerun_required
      try {
        await runRepo.updateRun(ctx.tx, ctx.tenantId, cur['id'], { status: 'closed', closed_at: ctx.now(), closed_by: ctx.actor.id, updated_by: ctx.actor.id });
      } catch (err) { throw mapWriteError(err, 'common.immutable_record'); }
      await review(ctx, cur['id'], 'close', comment);
      const { row, body } = await runBody(ctx, cur['id']);
      return { status: 200, version: row['version'], body };
    },

    /** #33 (AC-07.5): an acknowledgement row with a mandatory comment; the run must be evaluated or closed. */
    async acknowledgeQcRun(ctx: ReviewCtx, i: { runId: unknown; body: unknown }): Promise<Result> {
      await assert(ctx, REVIEW);
      if (!isUuid(i.runId)) throw notFound();
      const e = new Errs(), o = shape(e, i.body, ['comment']);
      const comment = o ? text(e, o, 'comment', 1, 500, true) : undefined;
      e.done();
      const cur = await loadRun(ctx, i.runId);
      assertRunAction(runState(cur), 'acknowledge');   // collecting -> 409 common.immutable_record
      const row = await review(ctx, cur['id'], 'acknowledge', comment);
      return { status: 201, body: reviewDto(row, await memberLabels(ctx, [membership(ctx)])) };
    },
  };
}
export type ReviewService = ReturnType<typeof createReviewService>;
