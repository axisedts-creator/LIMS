// C13 T10 — task partners.convert_manifest_line (02-TRD §8.1, 10 attempts). Thin wrapper: the logic lives in the partners module service.
import { convertLine, type ConversionCtx } from '../../../../../api/src/modules/partners/service/conversion.service.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const convertManifestLine: TaskHandler = (payload, ctx) => convertLine(payload, ctx as unknown as ConversionCtx);
