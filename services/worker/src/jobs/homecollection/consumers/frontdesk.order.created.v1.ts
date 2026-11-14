// frontdesk.order.created.v1 -> front_desk visit / order_registered_at + specimen refresh enqueue (US-02); logic in the C17 visit service (02-TRD §8.2).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onOrderCreated as created } from '../../../../../api/src/modules/homecollection/service/visit.service.js';

export const onOrderCreated: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;
  await created(ctx, event.payload);
};
