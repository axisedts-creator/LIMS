// engagement.booking.confirmed.v1 -> centre_visit: one pre_registered order via the shared createOrderFromBooking path (X5); home_collection: inbox only, no order (08 R7); cancelled link: ignored (US-FD-12.1/.4/.6).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onBookingConfirmed as confirmed } from '../../../../../api/src/modules/frontdesk/service/booking.service.js';

export const onBookingConfirmed: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;
  await confirmed(ctx, event.payload, event.aggregate?.seq);
};
