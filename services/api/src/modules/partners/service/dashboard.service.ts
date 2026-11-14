// A2 getPartnerDashboard counters (02-TRD §5.2; US-14.1/14.2). Every statement is one single-table aggregate in SQL binding tenant_id AND partner_id
// (token membership, ST2) — no row is pulled into JS. "Today" = the tenant calendar day of ctx.now() (tenant timezone), bounds bound as parameters.
//   submitted_today = SUM(manifests.line_count) submitted today; in_lab / rejected_open = tracking_status 'in_lab' / 'action_needed';
//   reported_today = tracking_status 'reported' with last_event_at today; new_reports = valid AND is_new; open_pickups = requested|scheduled;
//   outstanding = closing balance of the latest statement month (as S1 / US-12.2), outstanding_as_of = latest synced_at; both omitted without a statement row.
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import { isoUtc, money } from '../mappers/projection.dto.js';
import { localParts, offsetMs } from './referrer.service.js';

const SCOPE = 'tenant_id = $1 AND partner_id = $2'; // `$S` in the statements below
type Q ={ query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };

/** UTC instant of local 00:00 of (year, month0, day) in tz; day may overflow into the next month. Two passes settle a DST edge. */
const dayStart = (y: number, m0: number, d: number, tz: string): Date => {
  const guess = Date.UTC(y, m0, d);
  return new Date(guess - offsetMs(guess - offsetMs(guess, tz), tz));
};

async function todayBounds(ctx: HandlerContext): Promise<[Date, Date]> {
  const s = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone'] } as never) as unknown as Record<string, unknown>;
  const tz = s['timezone'], now = new Date(ctx.now() as unknown as string).getTime();
  if (typeof tz !== 'string' || Number.isNaN(now)) throw new LimsError('common.internal');
  try {
    const p = localParts(now, tz);
    return [dayStart(p.year, p.month - 1, p.day, tz), dayStart(p.year, p.month - 1, p.day + 1, tz)];
  } catch { throw new LimsError('common.internal'); } // bad zone: never fall back to UTC
}

export async function getDashboard(ctx: HandlerContext, partnerId: string) {
  const tx = ctx.tx as unknown as Q, tenantId = ctx.tenantId!;
  const [from, to] = await todayBounds(ctx);
  const one = async (sql: string, extra: unknown[] = []): Promise<number> =>
    Number((await tx.query(sql.split('$S').join(SCOPE), [tenantId, partnerId, ...extra])).rows[0]?.n ?? 0);
  // sequential: one request transaction = one connection, statements serialize anyway
  const submitted = await one('SELECT sum(line_count)::int AS n FROM partners.manifests WHERE $S AND submitted_at >= $3 AND submitted_at < $4', [from, to]);
  const inLab = await one("SELECT count(*)::int AS n FROM partners.order_tracking WHERE $S AND tracking_status = 'in_lab'");
  const reportedToday = await one("SELECT count(*)::int AS n FROM partners.order_tracking WHERE $S AND tracking_status = 'reported' AND last_event_at >= $3 AND last_event_at < $4", [from, to]);
  const rejected = await one("SELECT count(*)::int AS n FROM partners.order_tracking WHERE $S AND tracking_status = 'action_needed'");
  const newReports = await one("SELECT count(*)::int AS n FROM partners.order_reports WHERE $S AND status = 'valid' AND is_new = true");
  const pickups = await one("SELECT count(*)::int AS n FROM partners.pickup_requests WHERE $S AND state IN ('requested', 'scheduled')");
  const latest = await tx.query('SELECT closing_balance_paisa FROM partners.statement_months WHERE tenant_id = $1 AND partner_id = $2 ORDER BY period_month DESC, fiscal_year_bs DESC LIMIT 1', [tenantId, partnerId]);
  const asOf = await tx.query('SELECT max(synced_at) AS s FROM partners.statement_months WHERE tenant_id = $1 AND partner_id = $2', [tenantId, partnerId]);
  return {
    submitted_today: submitted, in_lab: inLab, reported_today: reportedToday, rejected_open: rejected, new_reports: newReports, open_pickups: pickups,
    ...(latest.rows[0] ? { outstanding: money(latest.rows[0].closing_balance_paisa), outstanding_as_of: isoUtc(asOf.rows[0].s) } : {}),
  };
}
