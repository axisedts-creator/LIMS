// Cron reporting.purge_ephemeral (02-TRD §9; 05-SCHEMA §2.14 / §6; 08 A13 P-6, P-12 (a)): per tenant, system actor, through the `__tenant_expired` policies.
// C6-T16 part: print_jobs past expires_at (24 h) and their files in reporting-prints. The canonical `reports` bucket is never touched (letterhead prints own no file).
// A file that cannot be deleted keeps its row (the next daily run retries); a file that is already gone does not block the row.
// [CONV] C6-T42 part: portal_payment_requests whose expires_at has passed (any status; lims_app has no DELETE, the system policy allows it).
// The other purge targets (otp_challenges, portal_sessions, quarantined inputs, delivery params) belong to no task yet: extend here, keep the tenant-scoped shape.
import type { TaskHandler } from '../../../core/manifest.js';
import { UUID } from './render_report_version.js';

const PRINTS_BUCKET = 'reporting-prints';
const BATCH = 500;   // ponytail: one batch per run; the rest follow on the next daily tick. Loop if a tenant ever expires > 500 prints a day.

export const purgeEphemeral: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any; const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.['tenant_id'] !== tenantId || !UUID.test(tenantId)) { ctx.log?.warn?.({ event: 'purge_ephemeral_skipped', reason: 'bad_payload' }); return; }
  const now: string = ctx.now();
  const expired: Array<{ id: string; object_path: string | null }> = (await ctx.tx.query(
    `SELECT id, object_path FROM reporting.print_jobs WHERE tenant_id = $1 AND expires_at < $2 ORDER BY expires_at LIMIT ${BATCH}`, [tenantId, now])).rows;
  const gone: string[] = [];
  for (const r of expired) {
    if (r.object_path) {
      if (!r.object_path.startsWith(`${tenantId}/`)) { ctx.log?.warn?.({ event: 'purge_ephemeral_foreign_path', print_job_id: r.id }); continue; }   // never delete outside the tenant prefix; row kept
      try { await ctx.storage.delete(PRINTS_BUCKET, r.object_path); } catch (e) {
        if ((e as { code?: string })?.code !== 'common.not_found') { ctx.log?.warn?.({ event: 'purge_ephemeral_delete_failed', print_job_id: r.id }); continue; }
      }
    }
    gone.push(r.id);
  }
  if (gone.length) await ctx.tx.query('DELETE FROM reporting.print_jobs WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND expires_at < $3', [tenantId, gone, now]);
  const payments = (await ctx.tx.query('DELETE FROM reporting.portal_payment_requests WHERE tenant_id = $1 AND expires_at < $2 RETURNING id', [tenantId, now])).rows as unknown[];   // C6-T42
  ctx.log?.info?.({ event: 'purge_ephemeral_done', print_jobs: gone.length, portal_payment_requests: payments.length });
};
