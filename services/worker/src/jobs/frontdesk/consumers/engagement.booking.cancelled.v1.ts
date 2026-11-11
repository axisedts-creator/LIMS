// engagement.booking.cancelled.v1 -> centre_visit: cancel a pre_registered order / flag a registered one / store a cancelled link for an unknown booking; home_collection: flag a linked registered order (US-FD-12.3/.4/.6; 08 R7, A2.12).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onBookingCancelled as cancelled } from '../../../../../api/src/modules/frontdesk/service/booking.service.js';

export const onBookingCancelled: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;
  await cancelled(ctx, event.payload, event.aggregate?.seq);
};
