'use client';
// S1 Owner dashboard body (03-APP-FLOW §5, 04-UI-UX §2/§3). Client component: the kit (react-aria) is client-only. Props are plain API JSON.
// Copy strings are the 04-UI-UX §11 catalogue values. Centre ids are never rendered (07-SECURITY).
import { Banner } from '@lims/ui/components/Banner';
import { BarChart } from '@lims/ui/components/BarChart';
import { Card } from '@lims/ui/components/Card';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FreshnessBadge } from '@lims/ui/components/FreshnessBadge';
import { Grid } from '@lims/ui/components/Grid';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile } from '@lims/ui/components/StatTile';
import { TimeSeriesChart } from '@lims/ui/components/TimeSeriesChart';
import type { DashboardDto, Tile } from '../server/dashboard.server';
import { ScopeBanner } from './ScopeBanner';
import { AutoRefresh, RefreshButton, ShowYesterday } from './DashboardActions';

const NUM = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const RS = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu' });
const money = (paisa: number) => `Rs. ${RS.format(paisa / 100)}`;
const fmt = (t: Tile) => (t.unit === 'paisa' ? money(t.value) : NUM.format(t.value));

function delta(t: Tile): { value: string; direction: 'up' | 'down' | 'flat'; isGood: boolean } | undefined {
  if (t.delta === undefined) return undefined;
  const direction = t.delta > 0 ? 'up' : t.delta < 0 ? 'down' : 'flat';
  const abs = Math.abs(t.delta);
  const sign = t.delta > 0 ? '+' : t.delta < 0 ? '-' : '';
  const pct = t.delta_bp === undefined ? '' : ` (${(Math.abs(t.delta_bp) / 100).toFixed(1)}%)`;
  return { value: `${sign}${t.unit === 'paisa' ? money(abs) : NUM.format(abs)}${pct}`, direction, isGood: direction !== 'down' };
}

const val = (d: DashboardDto, k: string) => d.tiles[k];
const sub = (d: DashboardDto, k: string) => { const t = val(d, k); return t ? fmt(t) : '0'; };

/** readOnly = embedded in a report run card (04-UI-UX §9): no page header, auto-refresh, refresh or "show yesterday" actions. */
export function DashboardView({ dto, query, readOnly = false }: { dto: DashboardDto; query: string; readOnly?: boolean }) {
  const { period, freshness } = dto;
  const stale = freshness.filter((f) => f.is_stale);
  const times = freshness.map((f) => f.refreshed_at).filter((x): x is string => !!x).sort();
  const oldest = times[0];
  const reason = stale[0]?.stale_reason;
  const caption = period.days === 1 ? 'vs yesterday' : `vs previous ${period.days} days`;

  // family = freshness[].family feeding the tile (03-APP-FLOW §5 S1 stale badge per tile); report_backlog = snapshot tiles [CONV].
  const cells: { key: string; label: string; href: string; family: string; extra: string[] }[] = [
    { key: 'patient_visits', label: 'Patient visits', href: '/analytics/reports/volume', family: 'orders', extra: [`New patients ${sub(dto, 'new_patients')}`] },
    { key: 'net_sales_paisa', label: 'Income (net sales)', href: '/analytics/reports/income', family: 'income', extra: [`Invoiced ${sub(dto, 'invoiced_paisa')}`, `Credit notes ${sub(dto, 'credit_notes_paisa')}`] },
    { key: 'results_approved', label: 'Results approved', href: '/analytics/reports/tests-done', family: 'results', extra: [`Tests ordered ${sub(dto, 'tests_ordered')}`] },
    { key: 'reports_pending', label: 'Reports pending', href: '/analytics/reports/pending-tests', family: 'report_backlog', extra: [`Ready, not released ${sub(dto, 'reports_ready_unreleased')}`] },
    { key: 'pending_tests', label: 'Pending tests', href: '/analytics/reports/pending-tests', family: 'report_backlog', extra: [`Overdue ${sub(dto, 'pending_overdue')}`] },
    ...(val(dto, 'net_collected_paisa') ? [{ key: 'net_collected_paisa', label: 'Cash collected (net)', href: '/analytics/collections', family: 'collections', extra: [] }] : []),
  ];
  const shown = cells.filter((c) => val(dto, c.key));
  const anyDelta = shown.some((c) => delta(val(dto, c.key)!));
  const empty = Object.values(dto.tiles).every((t) => !t || t.value === 0);
  const days = dto.series.days;
  const depts = dto.department_top;
  const status = (
    <>
      <FreshnessBadge isStale={stale.length > 0} {...(oldest ? { refreshedAt: oldest } : {})} {...(reason ? { reason } : {})} />
      {stale.length > 0 && oldest ? <span> Updated {WHEN.format(Date.parse(oldest))}</span> : null}
    </>
  );

  return (
    <>
      {readOnly ? (
        <div>{status}</div>
      ) : (
        <>
          <AutoRefresh />
          <PageHeader title="Dashboard" helpKey="analytics.dashboard" status={status} actions={<RefreshButton />} />
        </>
      )}
      <p>
        {period.label_ad} · {period.label_bs} B.S.
      </p>
      <ScopeBanner scope={dto.scope} />
      {period.timezone !== 'Asia/Kathmandu' ? <Banner tone="info" title="Business days are counted in Nepal time (UTC+05:45)." /> : null}
      <Grid columns={3}>
        {shown.map((c) => {
          const t = val(dto, c.key)!;
          const d = delta(t);
          const f = freshness.find((x) => x.family === c.family && x.is_stale);
          return (
            <div key={c.key}>
              <StatTile label={c.label} value={fmt(t)} href={c.href} {...(d ? { delta: d } : {})} />
              {f ? <FreshnessBadge isStale {...(f.refreshed_at ? { refreshedAt: f.refreshed_at } : {})} {...(f.stale_reason ? { reason: f.stale_reason } : {})} /> : null}
              {c.extra.length > 0 ? <ul>{c.extra.map((e) => <li key={e}>{e}</li>)}</ul> : null}
            </div>
          );
        })}
      </Grid>
      {anyDelta ? <p>{caption}</p> : null}
      <ul>
        <li>Counts each patient once per centre per day. Over several days the same person can be counted more than once.</li>
        <li>Income = invoices issued (incl. VAT/other tax) minus credit notes. Cash collected is shown separately.</li>
      </ul>
      {empty ? (
        <>
          <EmptyState title="No activity in this period" />
          {readOnly ? null : <ShowYesterday from={period.business_date_from} query={query} />}
        </>
      ) : (
        <Grid columns={2}>
          <Card>
            <TimeSeriesChart
              title="Net sales per day"
              unit="Rs."
              series={[{ id: 'net', label: 'Net sales', points: days.map((x) => ({ at: x.business_date, value: String(x.net_sales_paisa / 100) })) }]}
            />
          </Card>
          <Card>
            <BarChart
              title="Top departments by net sales"
              valueFormat="money"
              categories={depts.map((x) => (x.is_multiple ? 'Multiple departments' : x.label))}
              series={[{ id: 'net', label: 'Net sales', values: depts.map((x) => x.net_paisa) }]}
            />
          </Card>
        </Grid>
      )}
    </>
  );
}
