// ModuleManifest of module micro (02-CV §2.2, 02-TRD §7.2, §8.1) — the only file the core autoloader reads.
// C10 produces no event, owns no port, bearerJwt-only (no authResolvers / claimsResolver / systemPermissions).
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';

export const manifest: ModuleManifest = {
  name: 'micro',
  openapi: 'contracts/openapi/micro.yaml',
  handlers,
  produces: [],
};
