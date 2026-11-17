// frontdesk.discount_approval_expire (02-TRD §10; 03-APP-FLOW §1.3). Cron `*/5 * * * *`, per tenant, under that tenant's claims.
// pending | approved approvals with expires_at <= now become `expired` (rejected / consumed / expired are terminal and never touched). Only `status` and the row bookkeeping change:
// the decision, the binding and the consumption columns are preserved. Idempotent: a second run matches nothing. "now" is ctx.now() (testable clock), never the DB clock.
// REQ-SEC-024: acts only on the tenant the job was enqueued for; a payload for another tenant (or none) runs no statement.
import type { TaskHandler } from '../../../core/manifest.js';

export const DISCOUNT_APPROVAL_EXPIRE = 'frontdesk.discount_approval_expire';

export const discountApprovalExpire: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'discount_approval_expire_skipped', reason: 'bad_payload' });
    return;
  }
  const res = await ctx.tx.query(
    `UPDATE frontdesk.discount_approvals SET status = 'expired', version = version + 1, updated_at = now(), updated_by = $3
      WHERE tenant_id = $1 AND status IN ('pending', 'approved') AND expires_at <= $2::timestamptz`,
    [tenantId, ctx.now(), ctx.actor.id]);
  ctx.log?.info?.({ event: 'discount_approval_expire_done', expired: res?.rowCount ?? 0 });
};
