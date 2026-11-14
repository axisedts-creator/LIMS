// SI4 retryManifestLineConversion (T10) — LS7 retry (partners.manifest.receive, If-Match, Idempotency-Key). Logic in service/receipt.service.ts.
import type { Handler } from '../../../core/module.js';
import { retry } from '../service/receipt.service.js';

export const retryManifestLineConversion: Handler = (req, ctx) => retry(req, ctx);
