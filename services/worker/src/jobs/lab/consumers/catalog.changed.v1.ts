// catalog.changed.v1 -> lab (02-TRD §7.2; 03-IC §3.19): (1) T-28 invalidates the process CatalogPort cache (service/cache.ts) for the tenant by revision — any entity_type, an unknown
// value or `catalog_import` flushes the whole tenant (x-extensible); (2) a change of entity_type `instrument_code_map` also enqueues lab.reapply_unmapped_exceptions (AC-14.5 auto re-apply),
// payload { tenant_id, revision }, job_key `<tenant_id>:<revision>` (the same event twice = the same job). Other entity_types enqueue nothing and do not fail.
// REQ-SEC-024 / P-11: an envelope of another tenant (or a job without a tenant) is refused before any invalidation or query; a non-integer catalog_revision fails closed for every entity_type.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { getCatalogCache } from '../../../../../api/src/modules/lab/service/cache.js';
import type { ConsumerHandler } from '../../../core/manifest.js';

export const handle: ConsumerHandler = async (event, ctx) => {
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || event?.tenant_id !== ctx.tenantId) throw new LimsError('common.internal');
  const revision = event.payload?.catalog_revision;
  if (!Number.isInteger(revision)) throw new LimsError('common.internal');
  const entityType = event.payload?.entity_type;
  getCatalogCache().invalidate(ctx.tenantId, { revision, entityType: typeof entityType === 'string' ? entityType : '' });
  if (entityType !== 'instrument_code_map') return;
  await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, NULL, NULL)', [
    'lab.reapply_unmapped_exceptions', JSON.stringify({ tenant_id: ctx.tenantId, revision }), `${ctx.tenantId}:${revision}`,
  ]);
};
