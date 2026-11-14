// Consumer catalog.changed.v1 (CR-C13-006, 02-TRD §7.2, 03-IC §3.19): a price-relevant change enqueues partners.sync_price_list for every ACTIVE partner of the
// tenant with job_key pricelist:<partner_id> and run_at = now + 60 s (debounce: the same key replaces the pending job).
// Triggers: entity_type in {price_list, credit_party, test, panel, global_reference} OR any value C13 does not know (x-extensible: unknown = invalidate all,
// which includes 'catalog_import'). Other KNOWN values are inbox-only (no job). Unknown extra payload fields are ignored (02-CV §7.2).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { enqueuePriceListSyncs } from '../tasks/partners.sync_price_list.js';

/** known to C13 and irrelevant to prices (IC §3.19 enum minus the trigger set minus catalog_import). */
const IGNORED = new Set(['department', 'specimen_type', 'container', 'analyte', 'reference_range', 'critical_limit', 'comment_code', 'doctor', 'surcharge_rule',
  'tat_target', 'instrument_code_map', 'method', 'unit', 'value_set', 'tax_rule']);

export const onCatalogChanged: ConsumerHandler = async (event, ctx) => {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || event?.tenant_id !== tenantId) throw new Error('partners consumer catalog.changed.v1: envelope tenant differs from the job tenant');
  const entity = event.payload?.entity_type;
  if (typeof entity === 'string' && IGNORED.has(entity)) return;
  await enqueuePriceListSyncs(ctx, tenantId, new Date(new Date(ctx.now()).getTime() + 60_000).toISOString());
};
