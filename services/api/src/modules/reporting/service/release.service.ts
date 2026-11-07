// Release service (02-TRD §4.6 rules 1-6 and the transaction part of 8; 03-APP-FLOW V5). One implementation for R6 (manual, user actor) and the worker task
// reporting.release_if_eligible (auto, system actor). Runs on the caller's transaction (ctx.tx): any throw rolls back every write, event and enqueued job.
// Eligibility comes ONLY from BillingPort.getReleaseEligibility and is validated fail-closed; C6 never writes billing data. REQ-SEC-024: every statement binds tenant_id.
import { LimsError } from '../../../core/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';
export const RELEASED_EVENT = 'reporting.report.released.v1';
export const DISPATCH_TASK = 'reporting.dispatch_release_deliveries';
export const DISPATCH_MAX_ATTEMPTS = 10;
const ELIGIBLE_BASES = new Set(['paid_in_full', 'zero_balance', 'credit_party', 'override', 'policy_not_enforced']);
const HOLD_BASES = new Set(['due_outstanding', 'no_invoice']);

interface Tx { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface ReleaseCtx {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly actor: { readonly type?: string; readonly id: string };
  readonly ports: { billing: { getReleaseEligibility(ctx: any, i: { orderId: string }): Promise<any> }; frontdesk: { getPatientDemographics(ctx: any, i: { patientId: string; purpose: string }): Promise<any> } };
  readonly events: { publish(ctx: any, type: string, input: any): Promise<unknown> };
  readonly audit?: { access(entry: Record<string, unknown>): Promise<void> };
  now?(): string;
}
export interface ReleaseOpts { mode: 'manual' | 'auto'; expectedVersion?: number | undefined; audiences?: readonly string[] | undefined; suppressNotifications?: boolean | undefined }
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
  const { tx, tenantId } = ctx; const auto = o.mode === 'auto';
  const stop = (code: string): ReleaseOutcome => { if (auto) return { kind: 'skipped', reason: code }; throw new LimsError(code as any); };
  const now = iso(ctx.now ? ctx.now() : new Date().toISOString())!;
  if (ctx.actor.type === 'user' && !ctx.audit) throw new LimsError('common.internal');   // CR-C6-008: report.release access log is mandatory for user actors (fail closed)

  const v = (await tx.query(`SELECT id, report_id, version_no, status, report_kind, completeness, order_item_ids, page_count, pdf_bytes, rendered_at, version
    FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, versionId])).rows[0];
  if (!v) return stop('common.not_found');                                           // other tenants' rows are invisible: same answer
  const r = (await tx.query(`SELECT id, order_id, patient_id, centre_id, referrer_id, partner_id, order_source, state FROM reporting.reports
    WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, v.report_id])).rows[0];
  if (!r) return stop('common.not_found');
  if (r.state === 'cancelled') return stop('reporting.report_cancelled');
  if (v.status !== 'rendered') return stop('reporting.release_not_ready');
  if (!auto && v.version !== o.expectedVersion) throw new LimsError('common.version_conflict');
  const newer = (await tx.query(`SELECT version_no FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 AND version_no > $3 AND status <> 'discarded' LIMIT 1`,
    [tenantId, v.report_id, v.version_no])).rows[0];
  if (newer) return stop('reporting.version_not_latest');
  if (auto) {
    const s = (await tx.query('SELECT auto_release FROM reporting.settings WHERE tenant_id = $1', [tenantId])).rows[0];
    if ((s?.auto_release ?? 'when_eligible') !== 'when_eligible') return { kind: 'skipped', reason: 'auto_release_manual' };
  }

  const el = await eligibility(ctx, r.order_id);
  if (!el.eligible) {
    // 02-TRD §4.6 rule 2 extension members; core toProblem does not emit them yet (.orchestra/cr/C6-T13.md).
    if (!auto) throw Object.assign(new LimsError('reporting.release_blocked_due'), { extensions: { release_basis: el.basis, balance_due_paisa: el.balanceDuePaisa } });
    // [CONV] the hold columns are system metadata: no `version` bump, so a user's If-Match from the worklist is not invalidated by every sweep.
    await tx.query(`UPDATE reporting.report_versions SET held_basis = $3, held_checked_at = $4, updated_by = $5, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'rendered'`, [tenantId, versionId, el.basis, now, ctx.actor.id]);
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
  const prev = (await tx.query(`UPDATE reporting.report_versions SET status = 'superseded', superseded_at = $3, superseded_by_version_no = $4, version = version + 1,
      updated_by = $5, updated_at = now() WHERE tenant_id = $1 AND report_id = $2 AND status = 'released' RETURNING version_no`, [tenantId, v.report_id, now, v.version_no, ctx.actor.id])).rows[0];
  const supersedes: number | null = prev ? prev.version_no : null;
  const done = (await tx.query(`UPDATE reporting.report_versions SET status = 'released', released_at = $3, released_by = $4, release_mode = $5, release_basis = $6,
      release_override_id = $7, audiences = $8::text[], supersedes_version_no = $9, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND status = 'rendered' AND version = $10 RETURNING version`,
  [tenantId, versionId, now, ctx.actor.id, o.mode, el.basis, el.overrideId, audiences, supersedes, v.version])).rows[0];
  if (!done) throw new LimsError('common.version_conflict');                         // also for auto: the throw rolls the supersede back, the queue retries
  // final_released_at = first release of a COMPLETE version (05-SCHEMA); first_released_at keeps the original time.
  const rep = (await tx.query(`UPDATE reporting.reports SET released_version_no = $3, first_released_at = COALESCE(first_released_at, $4),
      final_released_at = COALESCE(final_released_at, $5), version = version + 1, updated_by = $6, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING version`,
  [tenantId, v.report_id, v.version_no, now, v.completeness === 'complete' ? now : null, ctx.actor.id])).rows[0];
  if (!rep) throw new LimsError('common.internal');
  await tx.query(`UPDATE reporting.portal_links SET revoked_at = $3, revoked_by = $4, revoke_reason_code = 'dues_settled', version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND report_id = $2 AND purpose = 'dues' AND revoked_at IS NULL`, [tenantId, v.report_id, now, ctx.actor.id]);

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
