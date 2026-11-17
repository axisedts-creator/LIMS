// lab.specimen.status_changed.v1 -> only to_status = recollection_ordered: the same open flag as the rejected path (deduplicated by the unique index); NO SMS here (02-TRD §8.2, 08 A13 D-6; US-FD-13.3).
// Any other to_status (known or a future one) is inbox only. A stale seq needs no check: the flag is insert-if-absent, so a redelivery is harmless.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { orderForEvent, raiseRecollectionFlag } from '../../../../../api/src/modules/frontdesk/service/flags.service.js';

export const onSpecimenStatusChanged: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;
  const p = event.payload;
  if (p?.to_status !== 'recollection_ordered' || typeof p.specimen_id !== 'string') return;
  const order = await orderForEvent(ctx, p.order_id);
  if (order) await raiseRecollectionFlag(ctx, order, p.specimen_id, event.event_id);
};
