// C13 T14 — task partners.purge_access_slips (02-TRD §8.1, 3 attempts; cron 02:50 NPT, per_tenant; payload { tenant_id }; 08 A2.1, A5.3).
// At link_expires_at the stored slip PDF goes: for every `issued` row of the job tenant with link_expires_at < now, delete the object (partners-slips; common.not_found = already gone = fine),
// then expire the row (file columns NULL, expired_at = now; link_id / link_expires_at stay). One transaction: a failing delete rolls every row back and the retry finishes (deleted objects count as gone). Idempotent by state.
// Makes no port call and never reads an object. Logs nothing.
// [CONV] ponytail: 500 slips per run; the rest is due at the next 02:50 run (raise the batch if a lab issues more slips per day than that).
import type { TaskHandler } from '../../../core/manifest.js';
import { slip } from '../../../../../api/src/modules/partners/service/observability.js';

const BUCKET = 'partners-slips';
const BATCH = 500;

export const purgeAccessSlips: TaskHandler = async (payload, ctx) => {
  const c = ctx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) throw new Error('partners.purge_access_slips: payload tenant differs from the job tenant context'); // REQ-SEC-024
  const now = new Date(ctx.now());
  const due: Array<Record<string, any>> = (await ctx.tx.query("SELECT id, file_path, version FROM partners.access_slips WHERE tenant_id = $1 AND state = 'issued' AND link_expires_at < $2 ORDER BY link_expires_at, id LIMIT $3", [tenantId, now, BATCH])).rows;
  for (const s of due) {
    try { await c.storage.delete(BUCKET, s.file_path); } catch (e) { if ((e as { code?: unknown } | null)?.code !== 'common.not_found') throw e; }
    await ctx.tx.query("UPDATE partners.access_slips SET state = 'expired', file_path = NULL, file_sha256 = NULL, file_byte_size = NULL, expired_at = $3, updated_at = $3, updated_by = $4, version = $5 WHERE tenant_id = $1 AND id = $2 AND state = 'issued'",
      [tenantId, s.id, now, ctx.actor.id, Number(s.version) + 1]);
  }
  if (due.length > 0) slip(ctx, 'expired', due.length); // T23: one inc with by = n, after the last write
};
