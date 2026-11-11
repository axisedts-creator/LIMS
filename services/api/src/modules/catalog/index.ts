// Catalog module manifest (02-TRD §3; core autoloader 02-TRD §6.3 of C0). ports.CatalogPort lands with its task.
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';

export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  handlers,
  produces: ['catalog.changed.v1'],
} as const satisfies ModuleManifest;
