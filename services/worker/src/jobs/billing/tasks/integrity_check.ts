// billing.integrity_check (02-TRD §10 row, §15). READ-ONLY: counts violations per check and reports them through
// lims_billing_integrity_violations_total{tenant_id,check}; never fixes (05-SCHEMA §3 "never auto-fix"). The task resolves on a violation
// (maxAttempts 1: retrying would not change the answer; the metric keeps firing every night until a human repairs the data).
// [CONV] checks: seq_gap | chronology | print_count | order_balance. Receipts (RC) = ledger_entries.receipt_seq; their chronology uses created_at.
import type { TaskHandler } from '../../../core/manifest.js';

export const INTEGRITY_CHECK = 'billing.integrity_check';
const METRIC = 'lims_billing_integrity_violations_total';

// invoices (series INV[:branch]) and credit notes (CN) share one shape: (series, fy, seq, issued_at, print_count, id, kind)
const DOCS = `select id, series, fiscal_year_bs, invoice_seq as seq, issued_at, print_count, 'invoice' as kind from billing.invoices where tenant_id = $1
  union all select id, series, fiscal_year_bs, credit_note_seq, issued_at, print_count, 'credit_note' from billing.credit_notes where tenant_id = $1`;
// every numbered series incl. receipts: (series, fy, seq, issued_at)
const SEQS = `select series, fiscal_year_bs, seq, issued_at from (${DOCS}) docs
  union all select 'RC', fiscal_year_bs, receipt_seq, created_at from billing.ledger_entries where tenant_id = $1 and receipt_seq is not null`;

const CHECKS: ReadonlyArray<readonly [check: string, sql: string]> = [
  // count = max(seq) (contiguous from 1) and the counter equals max(seq), per (series, FY)
  ['seq_gap', `with d as (${SEQS}),
    agg as (select series, fiscal_year_bs, count(*)::int as n, max(seq) as mx from d group by 1, 2),
    c as (select series, fiscal_year_bs, last_no from billing.fiscal_counters where tenant_id = $1 and series ~ '^(INV|CN|RC)')
    select count(*)::int as n from agg full join c using (series, fiscal_year_bs)
    where coalesce(agg.n, 0) <> coalesce(agg.mx, 0) or coalesce(c.last_no, 0) <> coalesce(agg.mx, 0)`],
  // ordering by seq = ordering by issued_at (created_at for receipts)
  ['chronology', `with d as (${SEQS}),
    o as (select issued_at < lag(issued_at) over (partition by series, fiscal_year_bs order by seq) as bad from d)
    select count(*)::int as n from o where bad`],
  // print_count = count(print_log rows of that document)
  ['print_count', `with d as (${DOCS})
    select count(*)::int as n from d where d.print_count <> (select count(*) from billing.print_log p
      where p.tenant_id = $1 and p.document_id = d.id and p.document_kind = d.kind)`],
  // order_balances = recomputation (invoiced = sum(invoices.net), credited = sum(credit_notes.net) joined via credit_notes.invoice_id (order_id is nullable), paid = sum(signed ledger amounts), TRD "Balance:"); only orders that have a balance row
  ['order_balance', `select count(*)::int as n from billing.order_balances b where b.tenant_id = $1
    and (b.invoiced_paisa <> coalesce((select sum(i.net_paisa) from billing.invoices i where i.tenant_id = $1 and i.order_id = b.order_id), 0)
      or b.credited_paisa <> coalesce((select sum(c.net_paisa) from billing.credit_notes c join billing.invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id where c.tenant_id = $1 and i.order_id = b.order_id), 0)
      or b.paid_paisa <> coalesce((select sum(l.amount_paisa) from billing.ledger_entries l where l.tenant_id = $1 and l.order_id = b.order_id), 0))`],
];

export const integrityCheck: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'integrity_check_skipped', reason: 'bad_payload' });
    return;
  }
  for (const [check, sql] of CHECKS) {
    const { rows } = await ctx.tx.query(sql, [tenantId]);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) {
      ctx.metrics.inc(METRIC, { tenant_id: tenantId, check }, n);
      ctx.log?.error?.({ event: 'billing_integrity_violation', check, count: n });
    }
  }
};
