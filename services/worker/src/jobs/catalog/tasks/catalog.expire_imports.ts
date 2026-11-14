// catalog.expire_imports (02-TRD §10, per_tenant, hourly): validated|invalid imports and ready exports past expires_at -> `expired`.
// Set-based, idempotent (a second run matches nothing), one job transaction. No revision bump, no event, no file/issue change (§9.1).
// Nothing but counts is logged (07 S-13). [CONV] "past" = expires_at < now(); rows with no expires_at never expire; queued/building exports are untouched.
import type { TaskHandler } from '../../../core/manifest.js';
import { claimedTenant } from './tenant.js';

export const EXPIRE_IMPORTS = 'catalog.expire_imports';

export const expireImports: TaskHandler = async (payload, ctx) => {
  const tenantId = claimedTenant(payload, ctx);
  const imports = await ctx.tx.query(
    `UPDATE catalog.imports SET status = 'expired', version = version + 1, updated_at = now(), updated_by = $2
     WHERE tenant_id = $1 AND status IN ('validated', 'invalid') AND expires_at < now()`,
    [tenantId, ctx.actor.id],
  );
  const exports = await ctx.tx.query(
    `UPDATE catalog.exports SET status = 'expired', version = version + 1, updated_at = now(), updated_by = $2
     WHERE tenant_id = $1 AND status = 'ready' AND expires_at < now()`,
    [tenantId, ctx.actor.id],
  );
  ctx.log.info({ imports: imports.rowCount, exports: exports.rowCount }, 'catalog.expire_imports done');
};
