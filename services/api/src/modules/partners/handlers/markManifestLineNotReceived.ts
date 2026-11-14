// SI5 markManifestLineNotReceived (T10) — LS4 / LS8 / D-104 sample_missing (partners.manifest.receive, If-Match). Logic in service/receipt.service.ts.
import type { Handler } from '../../../core/module.js';
import { markNotReceived } from '../service/receipt.service.js';

export const markManifestLineNotReceived: Handler = (req, ctx) => markNotReceived(req, ctx);
