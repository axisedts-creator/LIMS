// identity.expire_audit_exports (02-TRD §10 crontab, platform; AC-D4.5; 08 A17 P-18(c)). The DEFINER flips due exports to `expired`, deletes
// expired/failed rows > 1 year and returns the object paths; this task deletes those objects. Any storage failure other than "already gone"
// rejects the job: the tx rolls back, the rows stay `ready`, the next run sees them again (idempotent).
import type { TaskHandler } from '../../../core/manifest.js';
import { coreErrors, platformOnly, q } from './shared.js';

export const EXPIRE_AUDIT_EXPORTS = 'identity.expire_audit_exports';
const BUCKET = 'identity-exports';

export const expireAuditExports: TaskHandler = coreErrors(async (payload, ctx) => {
  platformOnly(EXPIRE_AUDIT_EXPORTS, payload, ctx);
  const rows = await q(ctx.tx, 'SELECT object_path FROM app.identity_expire_audit_exports()', []);
  const storage = ctx.storage as { delete(bucket: string, path: string): Promise<unknown> };
  let deleted = 0;
  for (const r of rows) {
    const path = r['object_path'];
    if (typeof path !== 'string' || path === '') continue;
    try { await storage.delete(BUCKET, path); deleted += 1; } catch (e) { if ((e as { code?: unknown })?.code !== 'common.not_found') throw e; }
  }
  ctx.log?.info?.({ event: EXPIRE_AUDIT_EXPORTS, expired: rows.length, objects_deleted: deleted });
});
