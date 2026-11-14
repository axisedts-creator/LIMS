// SI3 receiveManifest (T10) — staff receipt (partners.manifest.receive, If-Match, Idempotency-Key). Logic in service/receipt.service.ts.
import type { Handler } from '../../../core/module.js';
import { receive } from '../service/receipt.service.js';

export const receiveManifest: Handler = (req, ctx) => receive(req, ctx);
