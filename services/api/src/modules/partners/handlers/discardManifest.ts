// M10 discardManifest — POST /manifests/{manifest_id}/discard (partners.manifest.submit, If-Match). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { discard } from '../service/manifest.service.js';

export const discardManifest: Handler = (req, ctx) => discard(req, ctx);
