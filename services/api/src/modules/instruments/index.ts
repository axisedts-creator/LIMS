// ModuleManifest of module instruments (02-CV §2.2, 02-TRD §6.3) — the only file the core autoloader reads.
// API-T01 binds handlers + produced events only; the deviceToken authResolver is added by API-T03. Until then deviceToken
// operations fail closed (core has no handler for the scheme -> auth.unauthenticated).
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';

export const manifest: ModuleManifest = {
  name: 'instruments',
  openapi: 'contracts/openapi/instruments.yaml',
  handlers,
  // = EVENT_PRODUCERS.instruments (core validateManifest checks)
  produces: [
    'instruments.result.received.v1', 'instruments.qc.received.v1',
    'instruments.calibration.received.v1', 'instruments.agent.health_changed.v1',
  ],
};
