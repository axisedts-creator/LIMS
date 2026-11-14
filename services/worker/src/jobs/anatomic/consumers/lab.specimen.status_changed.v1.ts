// lab.specimen.status_changed.v1 -> anatomic intake (02-TRD §4.1, AC-01.1…01.10). The wrapper (core/consumer.ts) owns the event_inbox insert, envelope validation and tenant claims.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onSpecimenStatusChanged } from '../../../../../api/src/modules/anatomic/service/intake.service.js';

export const handle: ConsumerHandler = async (event, ctx) => {
  await onSpecimenStatusChanged(ctx as any, event);
};
