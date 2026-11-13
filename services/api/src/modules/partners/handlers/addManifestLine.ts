// M5 addManifestLine — POST /manifests/{manifest_id}/lines (partners.manifest.submit, If-Match = manifest version). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { addLine } from '../service/manifest.service.js';

export const addManifestLine: Handler = (req, ctx) => addLine(req, ctx);
