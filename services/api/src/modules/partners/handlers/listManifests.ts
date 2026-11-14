// M2 listManifests — GET /manifests (partners.order.read). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { list } from '../service/manifest.service.js';

export const listManifests: Handler = (req, ctx) => list(req, ctx);
