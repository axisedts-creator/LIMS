// frontdesk.order.items_changed.v1 -> add/remove items, cancel drafts, needs_assembly; stale items_version ignored (02-TRD §8.2; AC-01.3).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { applyItemsChanged, tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx: any) => { await applyItemsChanged(ctx, tenantFor(event, ctx), event.payload); };
