// M6 replaceManifestLine — PUT /manifests/{manifest_id}/lines/{line_id} (partners.manifest.submit, If-Match = line version). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { replaceLine } from '../service/manifest.service.js';

export const replaceManifestLine: Handler = (req, ctx) => replaceLine(req, ctx);
