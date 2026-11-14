// lab.result.approved.v1 -> approved_results + 1 for worklist progress, no assembly (02-TRD §8.2). Replays stop at the inbox.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { countApprovedResult, tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx: any) => { await countApprovedResult(ctx, tenantFor(event, ctx), event.payload.order_item_id); };
