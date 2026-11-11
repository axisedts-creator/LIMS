// catalog.changed.v1 -> lab (02-TRD §7.2): a change of entity_type `instrument_code_map` enqueues lab.reapply_unmapped_exceptions (AC-14.5 auto re-apply), payload { tenant_id, revision },
// job_key `<tenant_id>:<revision>` (the same event twice = the same job). Every other entity_type (the enum is x-extensible, 08 R13) enqueues nothing and does not fail.
// REQ-SEC-024 / P-08: an envelope of another tenant (or a job without a tenant) is refused before any query. Lab keeps no catalog cache of its own to invalidate.
import { LimsError } from '../../../../../api/src/core/errors.js';
import type { ConsumerHandler } from '../../../core/manifest.js';

export const handle: ConsumerHandler = async (event, ctx) => {
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || event?.tenant_id !== ctx.tenantId) throw new LimsError('common.internal');
  if (event.payload?.entity_type !== 'instrument_code_map') return;
  const revision = event.payload.catalog_revision;
  if (!Number.isInteger(revision)) throw new LimsError('common.internal');
  await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, NULL, NULL)', [
    'lab.reapply_unmapped_exceptions', JSON.stringify({ tenant_id: ctx.tenantId, revision }), `${ctx.tenantId}:${revision}`,
  ]);
};
