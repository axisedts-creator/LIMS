// frontdesk.order.created.v1 -> report shell, items, narrative drafts (02-TRD §8.2; AC-01.1, AC-01.2, AC-01.4).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { createFromOrderCreated, tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx: any) => { await createFromOrderCreated(ctx, tenantFor(event, ctx), event.payload); };
