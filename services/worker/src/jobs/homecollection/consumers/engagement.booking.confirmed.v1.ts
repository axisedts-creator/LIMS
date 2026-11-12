// engagement.booking.confirmed.v1 -> booking visit + booking_refs (US-01); logic in the C17 visit service (02-TRD §8.2).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onBookingConfirmed as confirmed } from '../../../../../api/src/modules/homecollection/service/visit.service.js';

export const onBookingConfirmed: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;
  await confirmed(ctx, event.payload, event.aggregate?.seq);
};
