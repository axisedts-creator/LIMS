// ModuleManifest of module lab (02-CV §2.2, 02-TRD §6.3) — the only file the core autoloader reads.
// T-01 binds handlers + produced events; T-24 registers LabPort (01 §5.1) as ports.LabPort.
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';
import { labPort } from './ports/LabPort.impl.js';

export const manifest: ModuleManifest = {
  name: 'lab',
  openapi: 'contracts/openapi/lab.yaml',
  handlers,
  ports: { LabPort: labPort },
  // = 02-TRD §7.1 = EVENT_PRODUCERS.lab (core validateManifest checks)
  produces: [
    'lab.specimen.status_changed.v1', 'lab.specimen.rejected.v1',
    'lab.result.verified.v1', 'lab.result.approved.v1', 'lab.result.amended.v1',
    'lab.order.ready_for_report.v1', 'lab.critical_value.detected.v1',
  ],
};
