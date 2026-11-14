// engagement.booking.cancelled.v1 -> cancel / flag the booking visit, remember the cancel in booking_refs (US-10); logic in the C17 visit service (02-TRD §8.2).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onBookingCancelled as cancelled } from '../../../../../api/src/modules/homecollection/service/visit.service.js';

export const onBookingCancelled: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;
  await cancelled(ctx, event.payload, event.aggregate?.seq);
};
