// billing.export_purge (02-TRD §10; 05-SCHEMA retention: objects 24 h, rows 90 days [CONV]). Cron `30 19 * * *`, per tenant, under that tenant's claims.
// Ready jobs past expires_at: the object is deleted from `billing-exports` (ctx.storage.delete, E-class) and the row becomes `expired` (object_path cleared). A failed delete leaves the row
// `ready` (retried tomorrow) and never stops the others. A path outside `{tenant_id}/` is never deleted. Expired / failed rows older than 90 days are removed (lims_app holds DELETE on this table only).
import type { TaskHandler } from '../../../core/manifest.js';
import { EXPORT_BUCKET } from './export_render.js';

export const EXPORT_PURGE = 'billing.export_purge';
const BATCH = 500;                                   // ponytail: one batch per run; the daily cron drains a backlog over days
const RETENTION_DAYS = 90;

export const exportPurge: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'export_purge_skipped', reason: 'bad_payload' });
    return;
  }
  const q = async (sql: string, values: unknown[]): Promise<Record<string, any>[]> => (await ctx.tx.query(sql, values)).rows;
  const now: string = ctx.now();
  const due = await q("SELECT id, object_path FROM billing.export_jobs WHERE tenant_id = $1 AND status = 'ready' AND expires_at <= $2::timestamptz ORDER BY expires_at, id LIMIT " + BATCH, [tenantId, now]);

  let purged = 0;
  for (const j of due) {
    const path = j['object_path'];
    if (typeof path !== 'string' || path.split('/')[0] !== tenantId) { ctx.log?.warn?.({ event: 'export_purge_skipped_path', export_id: j['id'] }); continue; }
    try { await ctx.storage.delete(EXPORT_BUCKET, path); } catch { ctx.log?.warn?.({ event: 'export_purge_delete_failed', export_id: j['id'] }); continue; }
    await q("UPDATE billing.export_jobs SET status = 'expired', object_path = NULL, bucket = NULL, version = version + 1, updated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'ready'",
      [tenantId, j['id'], ctx.actor.id]);
    purged++;
  }
  await q("DELETE FROM billing.export_jobs WHERE tenant_id = $1 AND status IN ('expired', 'failed') AND updated_at < $2::timestamptz - make_interval(days => $3)", [tenantId, now, RETENTION_DAYS]);
  ctx.log?.info?.({ event: 'export_purge_done', purged });
};
