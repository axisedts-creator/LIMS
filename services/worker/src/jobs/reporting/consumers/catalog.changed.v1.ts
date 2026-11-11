// catalog.changed.v1 (02-TRD §8.2). Any entity_type, known or not, is accepted (08 R13).
// ponytail: the reporting module keeps no in-process catalog cache yet (every lookup goes to CatalogPort), so there is nothing to
// invalidate; add the per-tenant invalidation + catalog_revision compare together with the cache.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx) => { tenantFor(event, ctx); };
