// lab.specimen.status_changed.v1 (02-TRD §8.2, A4). The C0 wrapper did inbox dedupe + validation and opened the transaction; the logic lives in culture.service.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onSpecimenStatusChanged as handle } from '../../../../../api/src/modules/micro/service/culture.service.js';

export const onSpecimenStatusChanged: ConsumerHandler = (event, ctx) => handle(ctx as any, event);
