// Release service (02-TRD §4.6 rules 1-6 and the transaction part of 8; 03-APP-FLOW V5). One implementation for R6 (manual, user actor) and the worker task
// reporting.release_if_eligible (auto, system actor). Runs on the caller's transaction (ctx.tx): any throw rolls back every write, event and enqueued job.
// Eligibility comes ONLY from BillingPort.getReleaseEligibility and is validated fail-closed; C6 never writes billing data. REQ-SEC-024: every statement binds tenant_id.
import { LimsError } from '../../../core/errors.js';
import * as repo from '../repository/releases.repo.js';
import { findSettings } from '../repository/settings.repo.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';
export const RELEASED_EVENT = 'reporting.report.released.v1';
export const DISPATCH_TASK = 'reporting.dispatch_release_deliveries';
export const DISPATCH_MAX_ATTEMPTS = 10;
const ELIGIBLE_BASES = new Set(['paid_in_full', 'zero_balance', 'credit_party', 'override', 'policy_not_enforced']);
const HOLD_BASES = new Set(['due_outstanding', 'no_invoice']);

interface Tx { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>; savepoint?<T>(fn: (tx: any) => Promise<T>): Promise<T> }
export interface ReleaseCtx {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly actor: { readonly type?: string; readonly id: string };
  readonly ports: { billing: { getReleaseEligibility(ctx: any, i: { orderId: string }): Promise<any> }; frontdesk: { getPatientDemographics(ctx: any, i: { patientId: string; purpose: string }): Promise<any> } };
  readonly events: { publish(ctx: any, type: string, input: any): Promise<unknown> };
  readonly audit?: { access(entry: Record<string, unknown>): Promise<void> };
  now?(): string;
}
export interface ReleaseOpts { mode: 'manual' | 'auto' | 'bulk'; expectedVersion?: number | undefined; audiences?: readonly string[] | undefined; suppressNotifications?: boolean | undefined }
export type ReleaseOutcome =
  | { kind: 'released'; id: string; versionNo: number; version: number; releasedAt: string; releaseBasis: string; audiences: string[]; supersedesVersionNo: number | null; row: Record<string, any> }
  | { kind: 'held'; basis: string }
  | { kind: 'skipped'; reason: string };

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

/** Asks BillingPort once and refuses any answer that is forged or self-contradictory (T13: release without payment). */
async function eligibility(ctx: ReleaseCtx, orderId: string): Promise<{ eligible: boolean; basis: string; overrideId: string | null; balanceDuePaisa: number | null }> {
  const r = await ctx.ports.billing.getReleaseEligibility(ctx, { orderId });
  const due = r?.balanceDue?.amount_paisa;
  const balanceDuePaisa = Number.isSafeInteger(due) ? (due as number) : null;
  if (r?.orderId === orderId && r.eligible === true && ELIGIBLE_BASES.has(r.basis) && (r.basis !== 'override' || (typeof r.overrideId === 'string' && UUID.test(r.overrideId)))) {
    return { eligible: true, basis: r.basis, overrideId: r.basis === 'override' ? r.overrideId : null, balanceDuePaisa };
  }
  if (r?.orderId === orderId && r.eligible === false && HOLD_BASES.has(r.basis)) return { eligible: false, basis: r.basis, overrideId: null, balanceDuePaisa };
  throw new LimsError('common.internal');
}

/** Rule 6: patient and centre always; referrer needs the order's referrer AND patient consent; partner for partner_manifest orders. Consent is read, never guessed. */
async function computedAudiences(ctx: ReleaseCtx, report: Record<string, any>): Promise<string[]> {
  const out = ['patient'];
  if (report['referrer_id']) {
    const d = await ctx.ports.frontdesk.getPatientDemographics(ctx, { patientId: report['patient_id'], purpose: 'notification' });
    if (d?.consents?.shareWithReferrer === true) out.push('referrer');
  }
  out.push('centre');
  if (report['order_source'] === 'partner_manifest') out.push('partner');
  return out;
}

export async function releaseVersion(ctx: ReleaseCtx, versionId: string, o: ReleaseOpts): Promise<ReleaseOutcome> {
  const { tx, tenantId } = ctx; const auto = o.mode === 'auto'; const bulk = o.mode === 'bulk';
  // auto and bulk report a skip instead of throwing (bulk maps the reason to a per-id outcome; R7 has no If-Match).
  const stop = (code: string): ReleaseOutcome => { if (auto || bulk) return { kind: 'skipped', reason: code }; throw new LimsError(code as any); };
  const now = iso(ctx.now ? ctx.now() : new Date().toISOString())!;
  if (ctx.actor.type === 'user' && !ctx.audit) throw new LimsError('common.internal');   // CR-C6-008: report.release access log is mandatory for user actors (fail closed)

  const v = await repo.findVersionForRelease(tx, tenantId, versionId);
  if (!v) return stop('common.not_found');                                           // other tenants' rows are invisible: same answer
  const r = await repo.lockReportForRelease(tx, tenantId, v.report_id);
  if (!r) return stop('common.not_found');
  if (r.state === 'cancelled') return stop('reporting.report_cancelled');
  if (v.status !== 'rendered') return stop(bulk && v.status === 'released' ? 'already_released' : 'reporting.release_not_ready');
  if (o.mode === 'manual' && v.version !== o.expectedVersion) throw new LimsError('common.version_conflict');
  if (await repo.hasNewerVersion(tx, tenantId, v.report_id, v.version_no)) return stop('reporting.version_not_latest');
  if (auto) {
    const s = await findSettings(tx, tenantId);
    if ((s?.auto_release ?? 'when_eligible') !== 'when_eligible') return { kind: 'skipped', reason: 'auto_release_manual' };
  }

  const el = await eligibility(ctx, r.order_id);
  if (!el.eligible) {
    if (bulk) return { kind: 'held', basis: el.basis };                              // R7 answers blocked_due and writes nothing (no hold metadata, rows untouched)
    // 02-TRD §4.6 rule 2 extension members; core toProblem does not emit them yet (.orchestra/cr/C6-T13.md).
    if (!auto) throw Object.assign(new LimsError('reporting.release_blocked_due'), { extensions: { release_basis: el.basis, balance_due_paisa: el.balanceDuePaisa } });
    // [CONV] the hold columns are system metadata: no `version` bump, so a user's If-Match from the worklist is not invalidated by every sweep.
    await repo.markHeld(tx, tenantId, versionId, el.basis, now, ctx.actor.id);
    return { kind: 'held', basis: el.basis };
  }

  let audiences: string[];
  if (o.suppressNotifications) audiences = ['print_only'];
  else {
    const computed = await computedAudiences(ctx, r);
    if (o.audiences === undefined) audiences = computed;
    else {
      if (o.audiences.length === 0 || !o.audiences.every((a) => computed.includes(a))) throw new LimsError('common.validation_failed', undefined, [{ path: '/audiences', code: 'common.field_invalid', message: 'Field invalid' }]);
      audiences = computed.filter((a) => o.audiences!.includes(a));
    }
  }

  // Rule 4, one transaction. Supersede BEFORE releasing: the partial unique index allows one `released` version per report.
  const supersedes = await repo.supersedeReleased(tx, tenantId, v.report_id, v.version_no, now, ctx.actor.id);
  const done = await repo.markReleased(tx, tenantId, versionId, v.version,
    { at: now, actorId: ctx.actor.id, mode: o.mode, basis: el.basis, overrideId: el.overrideId, audiences, supersedesVersionNo: supersedes });
  if (!done) throw new LimsError('common.version_conflict');                         // also for auto: the throw rolls the supersede back, the queue retries
  // final_released_at = first release of a COMPLETE version (05-SCHEMA); first_released_at keeps the original time.
  const rep = await repo.setReportReleased(tx, tenantId, v.report_id, v.version_no, now, v.completeness === 'complete' ? now : null, ctx.actor.id);
  if (!rep) throw new LimsError('common.internal');
  await repo.revokeDuesLinks(tx, tenantId, v.report_id, now, ctx.actor.id);

  await ctx.events.publish(ctx, RELEASED_EVENT, {
    aggregate: { type: 'report', id: v.report_id, seq: rep.version },
    idempotencyKey: `${v.report_id}:released:${v.version_no}`,
    payload: {
      report_id: v.report_id, version_no: v.version_no, order_id: r.order_id, patient_id: r.patient_id, centre_id: r.centre_id,
      ...(r.referrer_id ? { referrer_id: r.referrer_id } : {}), ...(r.partner_id ? { partner_id: r.partner_id } : {}),
      report_kind: v.report_kind, order_item_ids: v.order_item_ids, ...(supersedes !== null ? { supersedes_version_no: supersedes } : {}),
      released_at: now, release_basis: el.basis, audiences,
    },
  });
  await tx.query(ENQUEUE, [DISPATCH_TASK, JSON.stringify({ tenant_id: tenantId, report_version_id: versionId }), `dispatch:${versionId}`, null, DISPATCH_MAX_ATTEMPTS]);
  if (ctx.actor.type === 'user') {                                                   // CR-C6-008: access log for user actors only (presence checked up front)
    await ctx.audit!.access({ action: 'report.release', entityType: 'report_version', entityId: versionId, centreId: r.centre_id, outcome: 'allowed',
      detail: { release_basis: el.basis, ...(el.overrideId ? { override_id: el.overrideId } : {}) } });
  }
  return { kind: 'released', id: versionId, versionNo: v.version_no, version: done.version, releasedAt: now, releaseBasis: el.basis, audiences, supersedesVersionNo: supersedes,
    row: { report_kind: v.report_kind, completeness: v.completeness, page_count: v.page_count, pdf_bytes: v.pdf_bytes, rendered_at: v.rendered_at } };
}

// ---- R7 bulk release (02-TRD §4.6 rule 7, §6.3 R7; 03-APP-FLOW E5) ----
export type BulkOutcome = 'released' | 'blocked_due' | 'not_ready' | 'not_latest' | 'already_released' | 'cancelled' | 'not_found';
export interface BulkResult { id: string; outcome: BulkOutcome; release_basis?: string }
const SKIP_OUTCOME: Readonly<Record<string, BulkOutcome>> = Object.freeze({
  'common.not_found': 'not_found', 'reporting.report_cancelled': 'cancelled', 'reporting.version_not_latest': 'not_latest', already_released: 'already_released',
  'reporting.release_not_ready': 'not_ready',
});

/** Tenant limit: settings.bulk_release_max (no row -> 200). Throws reporting.bulk_release_too_large before any id is read. */
export async function assertBulkLimit(ctx: ReleaseCtx, count: number): Promise<void> {
  const max = (await findSettings(ctx.tx, ctx.tenantId))?.bulk_release_max ?? 200;
  if (count > max) throw new LimsError('reporting.bulk_release_too_large');
}

/** One savepoint per id: a failing id rolls back alone (rows, event, job, access log) and is answered not_ready [CONV: the R7 enum has no "error"]; the others go on. */
export async function bulkRelease(ctx: ReleaseCtx, ids: readonly string[]): Promise<BulkResult[]> {
  const out: BulkResult[] = [];
  for (const id of ids) {
    try {
      const r = await (ctx.tx.savepoint ? ctx.tx.savepoint((t) => releaseVersion({ ...ctx, tx: t }, id, { mode: 'bulk' })) : releaseVersion(ctx, id, { mode: 'bulk' }));
      if (r.kind === 'released') out.push({ id, outcome: 'released', release_basis: r.releaseBasis });
      else if (r.kind === 'held') out.push({ id, outcome: 'blocked_due' });
      else out.push({ id, outcome: SKIP_OUTCOME[r.reason] ?? 'not_ready' });
    } catch (e) {
      (ctx as any).log?.warn?.({ error_code: (e as any)?.code ?? 'unknown' }, 'bulk release: id rolled back');   // error code only, never input or PHI
      out.push({ id, outcome: 'not_ready' });
    }
  }
  return out;
}
