// Frontdesk module manifest (02-TRD §3.1, §6.3 autoloader).
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';
import { frontdeskPort } from './ports/FrontdeskPort.impl.js';

export const manifest: ModuleManifest = {
  name: 'frontdesk',
  openapi: 'contracts/openapi/frontdesk.yaml',
  produces: ['frontdesk.order.created.v1', 'frontdesk.order.items_changed.v1', 'frontdesk.order.cancelled.v1'],
  handlers,
  ports: { FrontdeskPort: frontdeskPort },
};
