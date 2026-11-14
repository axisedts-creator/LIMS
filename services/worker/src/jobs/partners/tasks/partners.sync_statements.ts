// partners.sync_statements (02-TRD §8.1, §8.2; 03-APP-FLOW line 195). Payload {tenant_id, partner_id} = one partner; {tenant_id} only = the cron tick: every
// partner of the tenant, suspended included. Reads billing.v_pub_credit_party_statement for THIS partner's credit party (tenant + credit_party_id bound), last 24
// months, and upserts partners.statement_months by (tenant, partner, month, fiscal year) with is_stale = false. A stored month in the window that the view no longer
// returned is KEPT and flagged is_stale = true (amounts untouched). synced_at / updated_at = ctx.now() as a bound parameter: one run, one timestamp.
// Outstanding (US-12.2) is derived by the API from the latest closing balance; nothing is computed here.
import type { JobContext, TaskHandler } from '../../../core/manifest.js';
import { scopeOf } from './partners.sync_price_list.js';

const WINDOW_MONTHS = 24;
const CHUNK = 500;

/** First day (UTC, 'YYYY-MM-01') of the month WINDOW_MONTHS before `now`. */
function windowStart(now: string): string {
  const d = new Date(now);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - WINDOW_MONTHS, 1));
  return t.toISOString().slice(0, 10);
}

async function syncOne(ctx: JobContext, tenantId: string, partner: { id: string; credit_party_id: string | null }): Promise<void> {
  if (!partner.credit_party_id) return;
  const tx = ctx.tx, now = ctx.now(), actor = ctx.actor.id, since = windowStart(now);
  const { rows } = await tx.query(
    "SELECT to_char(period_month, 'YYYY-MM-DD') AS month_day, fiscal_year_bs, invoiced_paisa, paid_paisa, credited_paisa, closing_balance_paisa "
    + 'FROM billing.v_pub_credit_party_statement WHERE tenant_id = $1 AND credit_party_id = $2 AND period_month >= $3', [tenantId, partner.credit_party_id, since]);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const params: unknown[] = [];
    const tuples = rows.slice(i, i + CHUNK).map((r: any) => `(${[tenantId, partner.id, partner.credit_party_id, r.month_day, r.fiscal_year_bs, r.invoiced_paisa, r.paid_paisa, r.credited_paisa,
      r.closing_balance_paisa, now, false, actor, now, actor].map((v) => `$${params.push(v)}`).join(', ')})`);
    await tx.query('INSERT INTO partners.statement_months (tenant_id, partner_id, credit_party_id, period_month, fiscal_year_bs, invoiced_paisa, paid_paisa, credited_paisa, '
      + `closing_balance_paisa, synced_at, is_stale, created_by, updated_at, updated_by) VALUES ${tuples.join(', ')} `
      + 'ON CONFLICT (tenant_id, partner_id, period_month, fiscal_year_bs) DO UPDATE SET credit_party_id = EXCLUDED.credit_party_id, invoiced_paisa = EXCLUDED.invoiced_paisa, '
      + 'paid_paisa = EXCLUDED.paid_paisa, credited_paisa = EXCLUDED.credited_paisa, closing_balance_paisa = EXCLUDED.closing_balance_paisa, synced_at = EXCLUDED.synced_at, '
      + 'is_stale = FALSE, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by', params);
  }
  // rows not touched by this run (synced_at older than now) but inside the window: the view dropped them
  await tx.query('UPDATE partners.statement_months SET is_stale = TRUE, updated_at = $3, updated_by = $4 '
    + 'WHERE tenant_id = $1 AND partner_id = $2 AND period_month >= $5 AND synced_at < $3 AND is_stale = FALSE', [tenantId, partner.id, now, actor, since]);
}

export const syncStatementsTask: TaskHandler = async (payload, ctx) => {
  const { tenantId, partnerId } = scopeOf(payload, ctx);
  const { rows } = partnerId === undefined
    ? await ctx.tx.query('SELECT id, credit_party_id FROM partners.partners WHERE tenant_id = $1', [tenantId])
    : await ctx.tx.query('SELECT id, credit_party_id FROM partners.partners WHERE tenant_id = $1 AND id = $2', [tenantId, partnerId]);
  for (const p of rows) await syncOne(ctx, tenantId, p);
};
