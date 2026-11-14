// frontdesk.trf_draft_purge (02-TRD §10; cron `15 * * * *`, per_tenant, 3 attempts; 05-SCHEMA §3 purge_trf_drafts; 08 A13 P-6, P-12 a E-class delete).
// Drafts = order_id IS NULL older than LIMS_FRONTDESK_TRF_DRAFT_TTL_HOURS (default 24), at most 1000 per run (the DEFINER refuses more; the next hour drains the rest).
// The storage objects are deleted FIRST; only the ids whose object delete succeeded go to the DEFINER frontdesk.purge_trf_drafts, so row and object never diverge (a failed delete keeps its row: next run retries).
// ponytail: the age filter uses the DB clock, like the DEFINER, so selection and deletion can never disagree.
// REQ-SEC-024: acts only on the tenant of the job claims; a payload for another tenant (or none) runs no statement. Logs carry counts only.
import { assertTenantPath } from '../../../../../api/src/core/storage/index.js';
import { loadFrontdeskConfig } from '../../../../../api/src/modules/frontdesk/config.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const TRF_DRAFT_PURGE = 'frontdesk.trf_draft_purge';
const BATCH = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const trfDraftPurge: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'trf_draft_purge_skipped', reason: 'bad_payload' });
    return;
  }
  const ttl = `${loadFrontdeskConfig().trfDraftTtlHours} hours`;
  const { rows } = await ctx.tx.query(
    `SELECT id, bucket, object_path FROM frontdesk.trf_attachments
      WHERE tenant_id = $1 AND order_id IS NULL AND created_at < now() - $2::interval ORDER BY created_at, id LIMIT ${BATCH}`, [tenantId, ttl]);

  const purge: string[] = []; let kept = 0;
  for (const r of rows) {
    try { assertTenantPath(tenantId, r.object_path); await ctx.storage.delete(r.bucket, r.object_path); purge.push(r.id); }
    catch { kept++; ctx.log.warn({ event: 'trf_draft_object_delete_failed', attachment_id: r.id }, 'trf_draft_object_delete_failed'); }   // keep the row: the next run retries
  }
  let purged = 0;
  if (purge.length > 0) purged = Number((await ctx.tx.query('SELECT frontdesk.purge_trf_drafts($1::interval, $2::uuid[]) AS n', [ttl, purge])).rows[0]?.n ?? 0);
  ctx.log.info({ event: 'trf_draft_purge_done', purged, kept }, 'trf_draft_purge_done');
};
