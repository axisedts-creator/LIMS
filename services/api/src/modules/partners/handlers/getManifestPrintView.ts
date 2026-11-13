// M11 getManifestPrintView (T09) — GET /manifests/{manifest_id}/print-view (partners.order.read). Writes one manifest.print access-log row. Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { printView } from '../service/manifest.service.js';

export const getManifestPrintView: Handler = (req, ctx) => printView(req, ctx);
