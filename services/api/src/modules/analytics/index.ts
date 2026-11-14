// ModuleManifest of module analytics (02-CV §2.2, 02-TRD §9.4) — the only file the core autoloader reads.
// C8 is consumer-only: produces no event, owns no port, bearerJwt-only (no authResolvers / claimsResolver).
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';

export const manifest: ModuleManifest = {
  name: 'analytics',
  openapi: 'contracts/openapi/analytics.yaml',
  handlers,
  produces: [],
};
