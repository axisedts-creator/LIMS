// M1 createManifest — POST /manifests (partners.manifest.submit). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { create } from '../service/manifest.service.js';

export const createManifest: Handler = (req, ctx) => create(req, ctx);
