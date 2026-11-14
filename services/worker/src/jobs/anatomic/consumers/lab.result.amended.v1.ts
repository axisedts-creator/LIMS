// lab.result.amended.v1 -> case_items.lab_approved_version_no (CR-C11-011, 02-TRD §8.2). The wrapper (core/consumer.ts) owns the event_inbox insert, envelope validation and tenant claims.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onResultAmended } from '../../../../../api/src/modules/anatomic/service/labresult.service.js';

export const handle: ConsumerHandler = async (event, ctx) => {
  await onResultAmended(ctx as any, event);
};
