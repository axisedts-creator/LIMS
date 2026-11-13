// catalog.changed.v1 -> engagement (02-TRD §7.2; CR-C16-013 ACCEPTED, EVENT_CONSUMERS.engagement lists it, so this consumer is active).
// entity_type in {test, panel, price_list, global_reference} OR any unknown value (x-extensible, 08 A13 P-4: safe default) -> enqueue ONE engagement.sync_bookable_items,
// job_key bookable:<tenant_id>, run_at = now + 60 s (debounce); every other known entity_type is ignored. The consumer never calls C3 and never touches the snapshot.
// A duplicate delivery or a burst of events collapses on the job_key. The tenant is the job tenant (ctx), never a value from the payload (REQ-SEC-024).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { enqueueSync } from '../tasks/sync_bookable_items.js';

const SYNC_TYPES = new Set(['test', 'panel', 'price_list', 'global_reference']);
const IGNORED_TYPES = new Set([   // known values of contracts/events/catalog.changed.v1.schema.json entity_type that cannot change a bookable item
  'department', 'specimen_type', 'container', 'analyte', 'reference_range', 'critical_limit', 'comment_code', 'doctor', 'credit_party', 'surcharge_rule', 'tat_target',
  'instrument_code_map', 'method', 'unit', 'value_set', 'tax_rule', 'catalog_import',
]);
const DEBOUNCE_MS = 60_000;

export const handle: ConsumerHandler = async (event, ctx) => {
  const type = event?.payload?.entity_type;
  if (typeof type === 'string' && !SYNC_TYPES.has(type) && IGNORED_TYPES.has(type)) return;
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || event?.tenant_id !== ctx.tenantId) throw new Error('catalog.changed.v1: tenant mismatch');   // fail closed: retried, never silently acked
  await enqueueSync(ctx, ctx.tenantId, new Date(Date.parse(ctx.now()) + DEBOUNCE_MS).toISOString());
};
