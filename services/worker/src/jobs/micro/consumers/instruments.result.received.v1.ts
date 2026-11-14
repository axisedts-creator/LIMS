// instruments.result.received.v1 (02-TRD §8.2, §4.8; PRD AC-08.1–08.12). The C0 wrapper did inbox dedupe + validation and opened the transaction; the logic lives in instrument-record.service.
// Handler contract (event, ctx); opens no transaction. Record kinds other than organism_id / ast leave only the inbox row.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { onInstrumentResult as handle } from '../../../../../api/src/modules/micro/service/instrument-record.service.js';

export const onInstrumentResult: ConsumerHandler = (event, ctx) => handle(ctx as any, event);
