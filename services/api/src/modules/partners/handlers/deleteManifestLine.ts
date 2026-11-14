// M7 deleteManifestLine — DELETE /manifests/{manifest_id}/lines/{line_id} (partners.manifest.submit, If-Match = line version). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { deleteLine } from '../service/manifest.service.js';

export const deleteManifestLine: Handler = (req, ctx) => deleteLine(req, ctx);
