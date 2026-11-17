// M8 submitManifest (T09) — POST /manifests/{manifest_id}/submit (partners.manifest.submit, If-Match, Idempotency-Key). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { submit } from '../service/manifest.service.js';

export const submitManifest: Handler = (req, ctx) => submit(req, ctx);
