// Task micro.purge_instrument_records (02-TRD §9; 05-SCHEMA §8 Class E purge; 01-PRD AC-08.12; 08 A17 D-65, A13 P-6; 07-SECURITY P-18(c)).
// per_tenant cron, system actor, the only DELETE in micro. Expiry is the DATABASE clock (the DELETE policy checks expires_at < now() too); a record that an AST row
// references (FK provenance of a stored value) is skipped. Batches of 1,000 until a short batch. Logs counts only: no barcode or raw value. A DB refusal rejects (retry).
import { LimsError } from '../../../../../api/src/core/errors.js';
import type { TaskHandler } from '../../../core/manifest.js';

const BATCH = 1000;
const DELETE = `DELETE FROM micro.instrument_records WHERE tenant_id = $1 AND id IN (
  SELECT r.id FROM micro.instrument_records r WHERE r.tenant_id = $1 AND r.expires_at < now()
    AND NOT EXISTS (SELECT 1 FROM micro.ast_results a WHERE a.tenant_id = r.tenant_id AND a.instrument_record_id = r.id)
  LIMIT ${BATCH})`;

export const purgeInstrumentRecords: TaskHandler = async (payload, ctx) => {
  const tenantId = ctx.tenantId;
  if (!tenantId || (payload?.tenant_id !== undefined && payload.tenant_id !== tenantId)) throw new LimsError('common.internal', 'micro purge_instrument_records: tenant mismatch');
  let total = 0, n: number;
  do {
    n = Number((await ctx.tx.query(DELETE, [tenantId])).rowCount ?? 0);
    if (n > 0) { total += n; (ctx as any).metrics.inc('lims_micro_instrument_records_purged_total', { tenant_id: tenantId }, n); }
  } while (n === BATCH);
  ctx.log.info({ task: 'micro.purge_instrument_records', purged: total }, 'micro purge_instrument_records done');
};
