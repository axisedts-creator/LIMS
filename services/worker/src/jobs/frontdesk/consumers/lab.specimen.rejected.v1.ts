// lab.specimen.rejected.v1 -> open recollection_required flag (one per specimen, D-6) + recollection_request SMS (02-TRD §8.2; US-FD-13.1/.2).
// The C0 wrapper already did inbox dedupe and schema validation; the handler is also idempotent on its own keys (unique index, SMS key). Tenant = ctx only: a foreign envelope writes nothing.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { orderForEvent, raiseRecollectionFlag, sendRecollectionSms } from '../../../../../api/src/modules/frontdesk/service/flags.service.js';

export const onSpecimenRejected: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;
  const p = event.payload;
  if (p?.recollection_required !== true || typeof p.specimen_id !== 'string') return;
  const order = await orderForEvent(ctx, p.order_id);
  if (!order) return;                                       // unknown order: no flag, no SMS from nothing
  await raiseRecollectionFlag(ctx, order, p.specimen_id, event.event_id);
  await sendRecollectionSms(ctx, order, p.specimen_id);     // best effort, never throws; the port dedupes on <specimen_id>:recollection_sms
};
