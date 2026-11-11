// ModuleManifest of module smartreport (02-TRD §3.1, 02-CV §2.2) — the only file the core autoloader reads.
// Produces no event; owns SmartReportPort; bearerJwt-only (no authResolvers / claimsResolver).
import type { ModuleManifest } from '../../core/module.js';
import { loadSmartreportConfig } from './config.js';
import { handlers } from './handlers/index.js';
import { smartReportPort } from './ports/SmartReportPort.impl.js';

export const config = loadSmartreportConfig(); // bad LIMS_SMARTREPORT_* stops the process at boot

export const manifest: ModuleManifest = {
  name: 'smartreport',
  openapi: 'contracts/openapi/smartreport.yaml',
  handlers,
  ports: { SmartReportPort: smartReportPort },
  produces: [],
  systemPermissions: ['lab.result.read', 'frontdesk.order.read'], // used by the worker too (TRD §3.1, §9.2)
};
