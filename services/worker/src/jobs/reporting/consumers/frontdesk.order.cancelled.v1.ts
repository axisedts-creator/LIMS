// frontdesk.order.cancelled.v1 -> reports cancelled, unreleased versions discarded, released ones flagged (02-TRD §8.2).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { cancelOrder, tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx: any) => { await cancelOrder(ctx, tenantFor(event, ctx), event.payload.order_id); };
