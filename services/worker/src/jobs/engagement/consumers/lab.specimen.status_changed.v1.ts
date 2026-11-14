// lab.specimen.status_changed.v1 -> engagement (02-TRD §4.4 consumer algorithm, §4.5 stage, §7.2 row 1; 02-CV §7.4; 01-PRD US-EN-07.1/2/3/5; 03-IC §3.7).
// Inbox dedupe is the core wrapper's. Here: no active/suspended link for payload.patient_id -> committed no-op (no view read, no write); partner order without show_partner_orders -> not projected;
// first sight of the order -> projected from the published views; the specimen is upserted with status_seq = aggregate.seq (a row already at that seq or higher is left alone); then the order stage is recomputed.
// No notification from this event (a recollection notice is the rejected event's). The tenant is the job tenant, never a payload value (REQ-SEC-024). Nothing of the payload is logged.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { SPECIMEN_STATUSES } from '../../../../../api/src/modules/engagement/domain/stage.js';
import { UUID, createProjectionService, projectionCtx } from '../../../../../api/src/modules/engagement/service/projection.service.js';

const projection = createProjectionService();
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export const handle: ConsumerHandler = async (event, ctx) => {
  const p = event?.payload ?? {}; const seq = event?.aggregate?.seq;
  const { specimen_id: specimenId, order_id: orderId, patient_id: patientId, specimen_type_code: type, to_status: to, changed_at: changedAt, replaces_specimen_id: replaces } = p;
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || event.tenant_id !== ctx.tenantId) return;
  if (![specimenId, orderId, patientId].every((v) => typeof v === 'string' && UUID.test(v)) || typeof type !== 'string' || !type || !Number.isInteger(seq) || seq < 0) return;
  if (!(SPECIMEN_STATUSES as readonly string[]).includes(to) || typeof changedAt !== 'string' || Number.isNaN(Date.parse(changedAt))) return; // the status set is closed (03-IC §10.1)

  const pctx = projectionCtx(ctx);
  if ((await projection.liveLinks(pctx, patientId)).length === 0) return;
  if (!(await projection.ensureOrder(pctx, { orderId, patientId }))) return;

  const existing = await projection.specimensOfOrder(pctx, orderId);
  const cur = existing.find((s) => s['specimen_id'] === specimenId);
  if (cur && Number(cur['status_seq']) >= seq) return; // stale or already applied
  // events carry no rejection data: keep what the rejected event stored (it may have arrived first); ordinal = "Sample n" in order of first sight
  await projection.upsertSpecimens(pctx, [{
    specimenId, orderId, patientId, specimenTypeCode: cur?.['specimen_type_code'] ?? type, status: to, statusSeq: seq, ordinal: cur ? Number(cur['ordinal']) : existing.length + 1,
    collectedAt: to === 'collected' ? changedAt : iso(cur?.['collected_at']), receivedAt: to === 'received' ? changedAt : iso(cur?.['received_at']),
    rejectedAt: iso(cur?.['rejected_at']) ?? (to === 'rejected' ? changedAt : null), rejectionReasonCode: cur?.['rejection_reason_code'] ?? null,
    recollectionRequired: to === 'recollection_ordered' || cur?.['recollection_required'] === true,
    replacesSpecimenId: typeof replaces === 'string' && UUID.test(replaces) ? replaces : (cur?.['replaces_specimen_id'] ?? null),
  }]);
  await projection.recomputeStages(pctx, [orderId]);
};
