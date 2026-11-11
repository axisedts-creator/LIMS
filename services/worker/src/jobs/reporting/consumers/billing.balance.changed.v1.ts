// billing.balance.changed.v1 -> hint columns on the order's reports (only when balance_version is newer) + keyed reporting.release_if_eligible for rendered versions
// (02-TRD §8.2; AC-06.2, AC-06.3). The event is only a HINT: this consumer never calls BillingPort and never releases; the task asks BillingPort again.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { ENQUEUE_SQL } from '../../../core/fanout.js';
import { tenantFor } from '../../../../../api/src/modules/reporting/service/reports.service.js';

export const handle: ConsumerHandler = async (event, ctx: any) => {
  const tenantId = tenantFor(event, ctx);
  const p = event.payload as any;
  const seq: unknown = p?.balance_version;
  const due: unknown = p?.balance_due?.amount_paisa;
  if (typeof p?.order_id !== 'string' || !Number.isInteger(seq) || !Number.isInteger(due) || typeof p.release_eligible !== 'boolean') return;

  const reports = (await ctx.tx.query('SELECT id, billing_balance_version FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2', [tenantId, p.order_id])).rows as
    { id: string; billing_balance_version: number | null }[];
  const fresh = reports.filter((r) => r.billing_balance_version == null || r.billing_balance_version < (seq as number));
  if (fresh.length === 0) return;                                                    // unknown order, stale or duplicate delivery
  const updated = (await ctx.tx.query(`UPDATE reporting.reports SET billing_balance_due_paisa = $3, billing_release_eligible = $4, billing_balance_version = $5,
      version = version + 1, updated_by = $6, updated_at = now()
    WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND (billing_balance_version IS NULL OR billing_balance_version < $5) RETURNING id`,
  [tenantId, fresh.map((r) => r.id), due, p.release_eligible, seq, ctx.actor.id])).rows as { id: string }[];
  if (!p.release_eligible || updated.length === 0) return;

  const rendered = (await ctx.tx.query(`SELECT id, report_id FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = ANY($2::uuid[]) AND status = 'rendered'`,
    [tenantId, updated.map((r) => r.id)])).rows as { id: string; report_id: string }[];
  for (const v of rendered) {
    await ctx.tx.query(ENQUEUE_SQL, ['reporting.release_if_eligible', JSON.stringify({ tenant_id: tenantId, report_id: v.report_id, report_version_id: v.id }), `release:${v.id}`, null, 10]);
  }
};
