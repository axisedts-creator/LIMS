// lab.result.amended.v1 -> amendment_pending = true until the next readiness event (02-TRD §8.2).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { markAmendmentPending, tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx: any) => { await markAmendmentPending(ctx, tenantFor(event, ctx), event.payload.order_item_id); };
