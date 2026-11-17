// Catalog module manifest (02-TRD §3; core autoloader 02-TRD §6.3 of C0).
// LD-185 (WIRE-CAT): ports.CatalogPort = the real port over ONE process-wide read cache (C3 02-TRD §6.3), bounds from loadCatalogConfig(process.env) (defaults apply, no env var needed).
// Construction does no I/O: the cache is an in-memory Map and the port only queries inside a request ctx.tx.
import type { ModuleManifest } from '../../core/module.js';
import { createCatalogCache } from './cache/catalogCache.js';
import { loadCatalogConfig } from './config.js';
import { handlers } from './handlers/index.js';
import { createCatalogPort } from './ports/CatalogPort.impl.js';

const config = loadCatalogConfig(process.env);
const CatalogPort = createCatalogPort({ cache: createCatalogCache({ maxEntries: config.cacheMaxEntries, ttlSeconds: config.cacheTtlSeconds }) });

export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  handlers,
  // LD-325(b): spec operations without a handler yet (answer 501 operation_pending). T0B-TESTMGMT-1 added the three test category handlers.
  // T0C-PRICETOOLS-1 (LD-321, LD-325(b)): the seven price list tool operations; T0B-PRICETOOLS-1 removes them when it adds the handlers.
  pendingOperations: ['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList', 'comparePriceLists', 'listPriceListImportBatches'],
  produces: ['catalog.changed.v1'],
  ports: { CatalogPort },
} as const satisfies ModuleManifest;
