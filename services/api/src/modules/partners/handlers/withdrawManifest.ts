// M9 withdrawManifest (T09) — POST /manifests/{manifest_id}/withdraw (partners.manifest.submit, If-Match, Idempotency-Key). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { withdraw } from '../service/manifest.service.js';

export const withdrawManifest: Handler = (req, ctx) => withdraw(req, ctx);
