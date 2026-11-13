// SI2 getInboundManifest (T10) — staff view, access log patient.view (partners.manifest.receive). Logic in service/receipt.service.ts.
import type { Handler } from '../../../core/module.js';
import { getInbound } from '../service/receipt.service.js';

export const getInboundManifest: Handler = (req, ctx) => getInbound(req, ctx);
