// ModuleManifest of module instruments (02-CV §2.2, 02-TRD §6.3) — the only file the core autoloader reads.
// API-T01 binds handlers + produced events; API-T03 adds the deviceToken authResolver.
import type { ModuleManifest } from '../../core/module.js';
import { createDeviceTokenResolver } from './auth/deviceTokenResolver.js';
import { handlers } from './handlers/index.js';

// ponytail: no-op sink — core metrics.ts DEFS lacks lims_instruments_device_auth_failures_total (createMetrics would throw);
// wire the core registry once .orchestra/cr/API-T03.md lands.
const deviceToken = createDeviceTokenResolver({ metrics: { inc: () => undefined } });

export const manifest: ModuleManifest = {
  name: 'instruments',
  openapi: 'contracts/openapi/instruments.yaml',
  handlers,
  // = EVENT_PRODUCERS.instruments (core validateManifest checks)
  produces: [
    'instruments.result.received.v1', 'instruments.qc.received.v1',
    'instruments.calibration.received.v1', 'instruments.agent.health_changed.v1',
  ],
  authResolvers: Object.freeze({ deviceToken }),
};
