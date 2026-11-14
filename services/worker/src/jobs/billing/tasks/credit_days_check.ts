// billing.credit_days_check (02-TRD §10; PRD US-BL-10.4): lock every unlocked credit account whose oldest unpaid periodic invoice is older than its credit_days
// (lock_reason_code = credit_days_exceeded, locked_by = the system actor). Never unlocks and never rewrites an existing lock (a manual lock keeps its reason): finance unlocks via B19.
// Unpaid = net - credited_total - signed ledger sum > 0. credit_days NULL = no terms = never auto-locked. Tenant setting billing.settings.credit_days_auto_lock = false switches the job off
// (no settings row = the default, true). Age is "strictly older than credit_days x 24 h" at ctx.now(). One statement, one tenant: re-running changes nothing.
import type { TaskHandler } from '../../../core/manifest.js';

export const CREDIT_DAYS_CHECK = 'billing.credit_days_check';

export const creditDaysCheck: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) { // REQ-SEC-024: the payload can never widen the tenant scope
    ctx.log?.warn?.({ event: 'credit_days_check_skipped', reason: 'bad_payload' });
    return;
  }
  const { rows } = await ctx.tx.query(
    `UPDATE billing.credit_accounts a
        SET is_locked = true, lock_reason_code = 'credit_days_exceeded', locked_at = $2::timestamptz, locked_by = $3::uuid,
            version = a.version + 1, updated_at = $2::timestamptz, updated_by = $3::uuid
      WHERE a.tenant_id = $1 AND NOT a.is_locked AND a.is_active AND a.credit_days IS NOT NULL
        AND COALESCE((SELECT st.credit_days_auto_lock FROM billing.settings st WHERE st.tenant_id = $1), true)
        AND EXISTS (SELECT 1 FROM billing.invoices i
                     WHERE i.tenant_id = a.tenant_id AND i.credit_party_id = a.credit_party_id AND i.is_periodic_credit_bill AND i.status = 'issued'
                       AND i.issued_at < $2::timestamptz - make_interval(days => a.credit_days)
                       AND i.net_paisa - i.credited_total_paisa
                           - COALESCE((SELECT SUM(l.amount_paisa) FROM billing.ledger_entries l WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id), 0) > 0)
      RETURNING a.credit_party_id`,
    [tenantId, ctx.now(), ctx.actor.id]);
  ctx.log?.info?.({ event: 'credit_days_check_done', locked: Array.isArray(rows) ? rows.length : 0 });
};
