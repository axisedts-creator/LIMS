// Task reporting.check_whatsapp_fallback (01-PRD AC-09.2; 02-TRD §4.8 "Fallback", §9; REQ-ARCH-085). Scheduled by the send task at sent_at + whatsapp_fallback_minutes.
// A WhatsApp delivery that is `failed`, or still `sent` (not delivered / read) once the delay has passed, gets ONE SMS fallback (if SMS is enabled + consented + a phone exists).
// The original row is never modified. Suppressed originals are handled by the send task itself (immediate fallback, review fix #19).
import type { TaskHandler } from '../../../core/manifest.js';
import { findDelivery } from '../../../../../api/src/modules/reporting/repository/delivery.repo.js';
import { findSettings } from '../../../../../api/src/modules/reporting/repository/settings.repo.js';
import { createSmsFallback, type FlowCtx } from '../../../../../api/src/modules/reporting/service/delivery.flow.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const checkWhatsappFallback: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as unknown as FlowCtx & { now(): string };
  const id = payload?.['delivery_id'];
  if (typeof ctx.tenantId !== 'string' || typeof id !== 'string' || !UUID.test(id)) return;
  const tx = ctx.tx as any;
  const d = await findDelivery(tx, ctx.tenantId, id, true);
  if (!d || d['channel'] !== 'whatsapp' || d['fallback_of_delivery_id']) return;
  let due = d['status'] === 'failed';
  if (d['status'] === 'sent' && d['sent_at']) {
    const minutes = (await findSettings(tx, ctx.tenantId))?.whatsapp_fallback_minutes ?? 30;
    due = new Date(d['sent_at']).getTime() +minutes * 60_000 <= Date.parse(ctx.now());
  }
  if (due) await createSmsFallback(ctx, d);
};
