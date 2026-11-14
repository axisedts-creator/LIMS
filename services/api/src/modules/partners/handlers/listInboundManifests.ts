// SI1 listInboundManifests (T10) — staff inbox (partners.manifest.receive). Logic in service/receipt.service.ts.
import type { Handler } from '../../../core/module.js';
import { listInbound } from '../service/receipt.service.js';

export const listInboundManifests: Handler = (req, ctx) => listInbound(req, ctx);
