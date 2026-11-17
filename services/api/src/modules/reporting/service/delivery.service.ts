// C6 delivery outbox (02-TRD §7.2 steps 1, 2, 5 centre, 7; 05-SCHEMA §2.8). Everything runs in the caller's ctx.tx (AC-16.3).
// No network: providers are reached only by the reporting.send_delivery task.
import type { Tx } from '../repository/settings.repo.js';
import { findActiveMessageTemplate, findDeliveryByKey as findByKey, insertDeliveryRow, oldestActiveCentreContact, type DeliveryRow } from '../repository/delivery.repo.js';
import type { TemplateParam } from '../domain/messages.js';

export type { DeliveryRow };
export interface DeliveryCtx {
  readonly tenantId: string; readonly requestId: string; readonly tx: unknown;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly events: { publish(ctx: unknown, type: string, input: { aggregate: { type: string; id: string; seq: number }; idempotencyKey: string; payload: Record<string, unknown> }): Promise<unknown> };
}
export interface Template { code: string; purpose: string; channels: string[]; params: TemplateParam[] }
export interface NewDelivery {
  id: string; centreId: string | null; channel: string; purpose: string; templateCode: string | null;
  recipientKind: string; recipientId: string | null; destinationMasked: string | null; destinationSha256: Buffer | null; destinationE164: string | null;
  params: Record<string, string>; idempotencyKey: string; relatedType: string | null; relatedId: string | null;
  reportId?: string | null; reportVersionNo?: number | null;
  status: 'queued' | 'suppressed' | 'sent'; failureCode: string | null;
  deferredLink?: Record<string, unknown> | null; fallbackOfDeliveryId?: string | null;
}

const tx = (ctx: DeliveryCtx) => ctx.tx as Tx;
const at = (ctx: DeliveryCtx): Date => ((ctx.tx as { startedAt?: Date }).startedAt ?? new Date());

export const findDeliveryByKey = (ctx: DeliveryCtx, key: string) => findByKey(tx(ctx), ctx.tenantId, key);

export async function findActiveTemplate(ctx: DeliveryCtx, code: string): Promise<Template | undefined> {
  const t = await findActiveMessageTemplate(tx(ctx), code);
  return t ? { code: t.code, purpose: t.purpose, channels: t.channels, params: Array.isArray(t.params) ? t.params : [] } : undefined;
}

export const oldestCentreContact = (ctx: DeliveryCtx, centreId: string, channel: string) => oldestActiveCentreContact(tx(ctx), ctx.tenantId, centreId, channel);

/**
 * Inserts the row; on a concurrent duplicate key returns the winner's row with `inserted: false` (REQ-SEC-024: one row, one job, one event).
 * Only a fresh insert publishes reporting.delivery.status_changed.v1 (absent → status) and, when queued, enqueues reporting.send_delivery
 * {delivery_id} with job key = delivery id (02-TRD §7.2 step 7: no address or params in the job).
 */
export async function insertDelivery(ctx: DeliveryCtx, d: NewDelivery): Promise<{ row: DeliveryRow; inserted: boolean }> {
  const now = at(ctx);
  const row = await insertDeliveryRow(tx(ctx), {
    ...d, tenantId: ctx.tenantId, reportId: d.reportId ?? null, reportVersionNo: d.reportVersionNo ?? null, actorId: ctx.actor.id,
    deferredLink: d.deferredLink ?? null, fallbackOfDeliveryId: d.fallbackOfDeliveryId ?? null,
    queuedAt: d.status === 'queued' ? now : null, sentAt: d.status === 'sent' ? now : null, suppressedAt: d.status === 'suppressed' ? now : null,
  });
  if (!row) {
    const prior = await findDeliveryByKey(ctx, d.idempotencyKey);
    if (!prior) throw new Error('reporting: delivery insert conflict without a visible row');
    return { row: prior, inserted: false };
  }
  await ctx.events.publish(ctx, 'reporting.delivery.status_changed.v1', {
    aggregate: { type: 'delivery', id: d.id, seq: 1 },
    idempotencyKey: `${d.id}:${d.status}`,
    payload: {
      delivery_id: d.id, channel: d.channel, purpose: d.purpose, recipient_kind: d.recipientKind, to_status: d.status,
      ...(d.failureCode ? { failure_code: d.failureCode } : {}),
      ...(d.reportId ? { report_id: d.reportId } : {}), ...(d.reportVersionNo ? { report_version_no: d.reportVersionNo } : {}),
      ...(d.fallbackOfDeliveryId ? { fallback_of_delivery_id: d.fallbackOfDeliveryId } : {}),
      changed_at: now.toISOString(), delivery_created_at: now.toISOString(), attempt_no: 1,
    },
  });
  if (d.status === 'queued') {
    await tx(ctx).query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['reporting.send_delivery', JSON.stringify({ delivery_id: d.id }), d.id]);
  }
  return { row, inserted: true };
}

/** reporting.delivery.status_changed.v1 for a transition of an existing row (seq = the row version after the update). */
export async function publishTransition(ctx: DeliveryCtx, row: Record<string, any>, to: string, o: { seq: number; at: string; attemptNo: number; failureCode?: string | null }): Promise<void> {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  await ctx.events.publish(ctx, 'reporting.delivery.status_changed.v1', {
    aggregate: { type: 'delivery', id: row['id'], seq: o.seq },
    idempotencyKey: `${row['id']}:${to}`,
    payload: {
      delivery_id: row['id'], channel: row['channel'], purpose: row['purpose'], recipient_kind: row['recipient_kind'], from_status: row['status'], to_status: to,
      ...(o.failureCode ? { failure_code: o.failureCode } : {}),
      ...(row['report_id'] ? { report_id: row['report_id'] } : {}), ...(row['report_version_no'] ? { report_version_no: row['report_version_no'] } : {}),
      ...(row['fallback_of_delivery_id'] ? { fallback_of_delivery_id: row['fallback_of_delivery_id'] } : {}),
      changed_at: o.at, delivery_created_at: iso(row['created_at']), attempt_no: o.attemptNo,
    },
  });
}

/** Print delivery (AC-12.1, review fix #5; 05-SCHEMA §2.8): channel print, template NULL, created directly in `sent`, key `<print_job_id>:print`. */
export async function recordPrintDelivery(ctx: DeliveryCtx, i: { id: string; printJobId: string; centreId: string | null; patientId: string; reportId: string; reportVersionNo: number }) {
  return insertDelivery(ctx, {
    id: i.id, centreId: i.centreId, channel: 'print', purpose: 'report_ready', templateCode: null, recipientKind: 'patient', recipientId: i.patientId,
    destinationMasked: null, destinationSha256: null, destinationE164: null, params: {}, idempotencyKey: `${i.printJobId}:print`,
    relatedType: 'report', relatedId: i.reportId, reportId: i.reportId, reportVersionNo: i.reportVersionNo, status: 'sent', failureCode: null,
  });
}
