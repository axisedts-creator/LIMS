// M4 updateManifest — PATCH /manifests/{manifest_id} (partners.manifest.submit, If-Match). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { update } from '../service/manifest.service.js';

export const updateManifest: Handler = (req, ctx) => update(req, ctx);
