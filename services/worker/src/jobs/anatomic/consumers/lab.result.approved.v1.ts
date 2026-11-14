// lab.result.approved.v1 -> case_items.lab_approved_version_no (CR-C11-011, 02-TRD §8.2). The wrapper (core/consumer.ts) owns the event_inbox insert, envelope validation and tenant claims.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onResultApproved } from '../../../../../api/src/modules/anatomic/service/labresult.service.js';

export const handle: ConsumerHandler = async (event, ctx) => {
  await onResultApproved(ctx as any, event);
};
