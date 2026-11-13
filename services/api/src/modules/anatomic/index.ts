// ModuleManifest of module anatomic (02-TRD §3.2, 02-CV §2.2) — the only file the core autoloader reads.
// Produces no event; owns no port (ports {}); bearerJwt-only (no authResolvers / claimsResolver).
import type { ModuleManifest } from '../../core/module.js';
import { loadAnatomicConfig } from './config.js';
import { handlers } from './handlers/index.js';

export const config = loadAnatomicConfig(); // bad LIMS_ANATOMIC_* stops the process at boot

export const manifest: ModuleManifest = {
  name: 'anatomic',
  openapi: 'contracts/openapi/anatomic.yaml',
  handlers,
  ports: {},
  produces: [],
  systemPermissions: ['anatomic.case.work', 'frontdesk.order.read', 'catalog.test.read'], // used by the worker too (TRD §3.2)
};
