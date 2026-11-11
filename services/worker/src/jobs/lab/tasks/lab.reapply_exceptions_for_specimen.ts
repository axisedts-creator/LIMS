// lab.reapply_exceptions_for_specimen (02-TRD §8; AC-04.5): enqueued in the receive transaction (job_key = specimen_id). Re-runs §4.5 for the open exceptions of that specimen's
// barcode whose reason is specimen_not_received or unknown_barcode. Payload { tenant_id, specimen_id } is ids only: the barcode is patient-linked and is looked up here.
import type { TaskHandler } from '../../../core/manifest.js';
import { guardTenant, MAX_PER_RUN, reapplyRows, taskStore } from './lab.reapply_shared.js';

export const handle: TaskHandler = async (payload, ctx) => {
  const tenantId = guardTenant(ctx, payload?.tenant_id);
  const specimenId = payload['specimen_id'];
  if (typeof specimenId !== 'string' || !specimenId) return;
  const store = taskStore(ctx);
  const barcode = await store.getSpecimenBarcode(ctx.tx, tenantId, specimenId);
  if (barcode === undefined) return;   // the specimen is gone: nothing to re-run
  const rows = await store.listOpenExceptions(ctx.tx, tenantId, { reasons: ['specimen_not_received', 'unknown_barcode'], barcode, limit: MAX_PER_RUN });
  await reapplyRows(ctx, store, rows);
};
