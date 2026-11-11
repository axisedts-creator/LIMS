// lab.reapply_unmapped_exceptions (02-TRD §8; AC-14.3, AC-14.5): enqueued by the catalog.changed.v1 consumer (job_key = `<tenant_id>:<revision>`) when an instrument code map changed.
// Re-runs §4.5 for the open unmapped_code exceptions, at most 500 per run [CONV]. A full page re-enqueues the task with a cursor (`after_id`, the last exception id of this run, ids ascend in creation order)
// and the job_key `<tenant_id>:<revision>:<after_id>`: the plain key is already taken, and without the cursor exceptions that stay unmapped would be listed again forever.
import { LimsError } from '../../../../../api/src/core/errors.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { guardTenant, MAX_PER_RUN, reapplyRows, taskStore } from './lab.reapply_shared.js';

export const handle: TaskHandler = async (payload, ctx) => {
  const tenantId = guardTenant(ctx, payload?.tenant_id);
  const revision = payload['revision'], afterId = payload['after_id'];
  if (!Number.isInteger(revision) || (afterId !== undefined && typeof afterId !== 'string')) throw new LimsError('common.internal');
  const store = taskStore(ctx);
  const rows = await store.listOpenExceptions(ctx.tx, tenantId, { reasons: ['unmapped_code'], limit: MAX_PER_RUN, ...(afterId === undefined ? {} : { afterId }) });
  await reapplyRows(ctx, store, rows);
  const last = rows[rows.length - 1];
  if (rows.length >= MAX_PER_RUN && last) {
    await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, NULL, NULL)', [
      'lab.reapply_unmapped_exceptions', JSON.stringify({ tenant_id: tenantId, revision, after_id: last['id'] }), `${tenantId}:${revision}:${last['id']}`,
    ]);
  }
};
