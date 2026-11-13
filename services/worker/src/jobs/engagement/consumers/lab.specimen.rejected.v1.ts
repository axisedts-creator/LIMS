// lab.specimen.rejected.v1 -> engagement (02-TRD §4.4, §4.9 sample_recollection, §7.2 row 2; 01-PRD US-EN-07.4; 03-IC §3.8). C5 emits it together with status_changed(rejected) under the same aggregate seq.
// Stores rejected_at + rejection_reason_code (staff-only, P1: never logged, never in a notification) + recollection_required on the specimen; recollection_required -> stage recollection_needed and ONE
// notification per linked account and specimen (entity = the order, entity_seq = the specimen's "Sample n"). Same seq as the status event is applied; a lower seq than the row is stale.
// A specimen not projected yet THROWS (rolled back, retried after the status event) - never acked and lost. Unlinked / filtered order -> committed no-op.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { UUID, createProjectionService, projectionCtx } from '../../../../../api/src/modules/engagement/service/projection.service.js';
import { createNotificationService } from '../../../../../api/src/modules/engagement/service/notification.service.js';

const projection = createProjectionService(), notifications = createNotificationService();
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export const handle: ConsumerHandler = async (event, ctx) => {
  const p = event?.payload ?? {}; const seq = event?.aggregate?.seq;
  const { specimen_id: specimenId, order_id: orderId, patient_id: patientId, reason_code: reason, rejected_at: rejectedAt } = p;
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || event.tenant_id !== ctx.tenantId) return;
  if (![specimenId, orderId, patientId].every((v) => typeof v === 'string' && UUID.test(v)) || !Number.isInteger(seq) || seq < 0 || typeof reason !== 'string' || !reason || typeof rejectedAt !== 'string' || Number.isNaN(Date.parse(rejectedAt))) return;

  const pctx = projectionCtx(ctx);
  const links = await projection.liveLinks(pctx, patientId);
  if (links.length === 0) return;
  const order = await projection.ensureOrder(pctx, { orderId, patientId });
  if (!order) return;

  const existing = await projection.specimensOfOrder(pctx, orderId);
  const cur = existing.find((s) => s['specimen_id'] === specimenId);
  if (!cur) throw new Error('specimen_not_projected_yet'); // the specimen row (type, ordinal) comes from status_changed; retry
  if (Number(cur['status_seq']) > seq) return; // stale
  const recollection = p.recollection_required === true;
  await projection.upsertSpecimens(pctx, [{
    specimenId, orderId, patientId, specimenTypeCode: cur['specimen_type_code'], status: 'rejected', statusSeq: seq, ordinal: Number(cur['ordinal']), collectedAt: iso(cur['collected_at']), receivedAt: iso(cur['received_at']),
    rejectedAt, rejectionReasonCode: reason.slice(0, 64), recollectionRequired: recollection, replacesSpecimenId: cur['replaces_specimen_id'] ?? null,
  }]);
  await projection.recomputeStages(pctx, [orderId]);
  if (!recollection) return;
  const visible = (l: Record<string, any>) => l['status'] === 'active' && (l['visible_from'] == null || Date.parse(order.visibleAt) >= Date.parse(iso(l['visible_from'])!));
  await notifications.create(pctx, links.filter(visible).map((l) => ({ accountId: l['account_id'], patientId, kind: 'sample_recollection' as const, entityType: 'order' as const, entityId: orderId, entitySeq: Number(cur['ordinal']), routeId: 'patient_app.order' as const })));
};
