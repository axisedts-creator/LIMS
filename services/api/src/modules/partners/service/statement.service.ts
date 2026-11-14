// S1 listPartnerStatements / S2 getPartnerStatement reads (02-TRD §5.2): the partner's own partners.statement_months, newest month first, one row per
// (A.D. month, B.S. fiscal year). Every read binds tenant_id AND partner_id (token membership) on top of RLS (US-12.1, 07-SECURITY partner finance data).
// Outstanding (US-12.2) = closing balance of the latest (period_month, fiscal_year_bs) row; as-of = the latest synced_at.
import { LimsError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor, isoUtc, money, monthStart, parseLimit } from '../mappers/projection.dto.js';

type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
const FY = /^[0-9]{4}\/[0-9]{2}$/, MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const COLS = "to_char(period_month, 'YYYY-MM') AS period_ym, fiscal_year_bs, invoiced_paisa, paid_paisa, credited_paisa, closing_balance_paisa, synced_at";
const LATEST = 'ORDER BY period_month DESC, fiscal_year_bs DESC';

const toDto = (r: any) => ({
  period_month: r.period_ym as string, fiscal_year_bs: r.fiscal_year_bs as string, invoiced: money(r.invoiced_paisa), paid: money(r.paid_paisa),
  credited: money(r.credited_paisa), closing_balance: money(r.closing_balance_paisa), synced_at: isoUtc(r.synced_at),
});
const lastSync = async (tx: Q, tenantId: string, partnerId: string): Promise<unknown> =>
  (await tx.query('SELECT synced_at FROM partners.statement_months WHERE tenant_id = $1 AND partner_id = $2 ORDER BY synced_at DESC LIMIT 1', [tenantId, partnerId])).rows[0]?.synced_at;

export interface StatementQuery { period_month_from?: unknown; period_month_to?: unknown; cursor?: unknown; limit?: unknown }

export async function listStatements(tx: Q, tenantId: string, partnerId: string, query: StatementQuery) {
  const limit = parseLimit(query.limit);
  const from = query.period_month_from === undefined ? undefined : monthStart(query.period_month_from);
  const to = query.period_month_to === undefined ? undefined : monthStart(query.period_month_to);
  const cur = decodeCursor(query.cursor, 's', ['m', 'f']);
  if (cur && (!MONTH.test(cur['m']!) || !FY.test(cur['f']!))) throw new LimsError('common.invalid_cursor');

  const values: unknown[] = [tenantId, partnerId];
  const bind = (v: unknown) => `$${values.push(v)}`;
  const where = ['tenant_id = $1', 'partner_id = $2'];
  if (from) where.push(`period_month >= ${bind(from)}`);
  if (to) where.push(`period_month <= ${bind(to)}`);
  if (cur) where.push(`(period_month, fiscal_year_bs) < (${bind(`${cur['m']}-01`)}, ${bind(cur['f'])})`);
  const page = await tx.query(`SELECT ${COLS} FROM partners.statement_months WHERE ${where.join(' AND ')} ${LATEST} LIMIT ${bind(limit + 1)}`, values);
  const latest = await tx.query(`SELECT closing_balance_paisa FROM partners.statement_months WHERE tenant_id = $1 AND partner_id = $2 ${LATEST} LIMIT 1`, [tenantId, partnerId]);
  const asOf = await lastSync(tx, tenantId, partnerId);

  const more = page.rows.length > limit;
  const rows = page.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    data: rows.map(toDto),
    page: { limit, ...(more && last ? { next_cursor: encodeCursor({ t: 's', m: last.period_ym, f: last.fiscal_year_bs }) } : {}) },
    ...(latest.rows[0] ? { outstanding: money(latest.rows[0].closing_balance_paisa), outstanding_as_of: isoUtc(asOf) } : {}),
  };
}

export async function getStatement(tx: Q, tenantId: string, partnerId: string, periodMonth: unknown, now: string) {
  const start = monthStart(periodMonth); // validated before any SQL
  const { rows } = await tx.query(
    `SELECT ${COLS} FROM partners.statement_months WHERE tenant_id = $1 AND partner_id = $2 AND period_month = $3 ORDER BY fiscal_year_bs`, [tenantId, partnerId, start]);
  // empty month = empty state, not an error (US-12.4); the schema needs synced_at, so: the partner's last sync (ctx.now() if it was never synced)
  const synced = rows.length ? rows.reduce((m, r) => (new Date(r.synced_at) > new Date(m) ? r.synced_at : m), rows[0].synced_at) : (await lastSync(tx, tenantId, partnerId)) ?? now;
  return { period_month: periodMonth as string, rows: rows.map(toDto), synced_at: isoUtc(synced) };
}
