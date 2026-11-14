// M3 getManifest — GET /manifests/{manifest_id} (partners.order.read). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { get } from '../service/manifest.service.js';

export const getManifest: Handler = (req, ctx) => get(req, ctx);
