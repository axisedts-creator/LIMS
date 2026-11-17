// catalog.changed.v1 (02-TRD §8.2): C4 keeps no catalog cache or revision store (quotes resolve through CatalogPort per call), so there is nothing to invalidate or record; entity_type is x-extensible,
// an unknown value is accepted like any other. No side effects, no event. ponytail: add the 60 s per-tenant orderable-metadata invalidation here if such a cache is ever introduced.
import type { ConsumerHandler } from '../../../core/manifest.js';

export const onCatalogChanged: ConsumerHandler = async () => undefined;
