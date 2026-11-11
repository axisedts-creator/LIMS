// lab.specimen.status_changed.v1 -> report_order_items.specimen_hint, ordered by aggregate.seq (02-TRD §8.2).
// [CONV] a payload without order_item_ids marks nothing.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { setSpecimenHint, tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx: any) => {
  await setSpecimenHint(ctx, tenantFor(event, ctx), event.payload.order_item_ids ?? [], event.payload.to_status, event.aggregate.seq);
};
