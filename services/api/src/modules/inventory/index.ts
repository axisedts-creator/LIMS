// inventory module manifest (02-TRD §3.1). Pure producer-less consumer module: produces [] (CM §5.1), no ports, no resolvers.
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';

export const manifest: ModuleManifest = {
  name: 'inventory',
  openapi: 'contracts/openapi/inventory.yaml',
  handlers,
  produces: [],
};
