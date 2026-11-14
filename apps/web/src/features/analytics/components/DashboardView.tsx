'use client';
// S1 Owner dashboard body (03-APP-FLOW §5, 04-UI-UX §2/§3). Client component: the kit (react-aria) is client-only. Props are plain API JSON.
// Copy strings are the 04-UI-UX §11 catalogue values. Centre ids are never rendered (07-SECURITY).
import { useId } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { BarChart } from '@lims/ui/components/BarChart';
import { Card } from '@lims/ui/components/Card';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FreshnessBadge } from '@lims/ui/components/FreshnessBadge';
import { Grid } from '@lims/ui/components/Grid';
import { Inline } from '@lims/ui/components/Inline';
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

type Cell = { key: string; label: string; href: string; family: string; extra: string[] };
const val = (d: DashboardDto, k: string) => d.tiles[k];
const sub = (d: DashboardDto, k: string) => { const t = val(d, k); return t ? fmt(t) : '0'; };

/** readOnly = embedded in a report run card (04-UI-UX §9): no page header, auto-refresh, refresh or "show yesterday" actions. */
export function DashboardView({ dto, query, readOnly = false }: { dto: DashboardDto; query: string; readOnly?: boolean }) {
  const { period, freshness } = dto;
  const needsId = useId();
  const moneyId = useId();
  const stale = freshness.filter((f) => f.is_stale);
  const times = freshness.map((f) => f.refreshed_at).filter((x): x is string => !!x).sort();
  const oldest = times[0];
  const reason = stale[0]?.stale_reason;
  const caption = period.days === 1 ? 'vs yesterday' : `vs previous ${period.days} days`;

  // family = freshness[].family feeding the tile (03-APP-FLOW §5 S1 stale badge per tile); report_backlog = snapshot tiles [CONV].
  const cells: Record<string, Cell> = {
    patient_visits: { key: 'patient_visits', label: 'Patient visits', href: '/analytics/reports/volume', family: 'orders', extra: [`New patients ${sub(dto, 'new_patients')}`] },
    net_sales_paisa: { key: 'net_sales_paisa', label: 'Income (net sales)', href: '/analytics/reports/income', family: 'income', extra: [`Invoiced ${sub(dto, 'invoiced_paisa')}`, `Credit notes ${sub(dto, 'credit_notes_paisa')}`] },
    results_approved: { key: 'results_approved', label: 'Results approved', href: '/analytics/reports/tests-done', family: 'results', extra: [`Tests ordered ${sub(dto, 'tests_ordered')}`] },
    reports_pending: { key: 'reports_pending', label: 'Reports pending', href: '/analytics/reports/pending-tests', family: 'report_backlog', extra: [] },
    pending_tests: { key: 'pending_tests', label: 'Pending tests', href: '/analytics/reports/pending-tests', family: 'report_backlog', extra: [] },
    net_collected_paisa: { key: 'net_collected_paisa', label: 'Cash collected (net)', href: '/analytics/collections', family: 'collections', extra: [] },
  };
  const shown = Object.values(cells).filter((c) => val(dto, c.key));
  const anyDelta = shown.some((c) => delta(val(dto, c.key)!));
  const empty = Object.values(dto.tiles).every((t) => !t || t.value === 0);
  const sent = (k: string) => shown.some((c) => c.key === k);

  // A tile's cell: tile + its stale badge + its sub-values (an-t18 binds the badge to the cell).
  const extras = (c: Cell) => {
    const f = freshness.find((x) => x.family === c.family && x.is_stale);
    return (
      <>
        {f ? <FreshnessBadge isStale {...(f.refreshed_at ? { refreshedAt: f.refreshed_at } : {})} {...(f.stale_reason ? { reason: f.stale_reason } : {})} /> : null}
        {/* sub-values as text, not a nested list: inside the pipeline they must not read as extra stages */}
        {c.extra.map((e) => <p key={e}>{e}</p>)}
      </>
    );
  };
  const tileOf = (c: Cell, linked: boolean) => {
    const t = val(dto, c.key)!;
    const d = delta(t);
    return <StatTile label={c.label} value={fmt(t)} {...(linked ? { href: c.href } : {})} {...(d ? { delta: d } : {})} />;
  };
  const cell = (c: Cell) => (
    <div key={c.key}>
      {tileOf(c, true)}
      {extras(c)}
    </div>
  );

  // LD-140 / 10-DESIGN-SYSTEM s4 "Today": one pipeline stepper. Only stages with an API tile get a count + filter link; the others show the label only
  // (no new data, no invented 0). Stage sources per RS-C8-ruling.md: In progress = pending_tests, Authorised = results_approved.
  const STAGES: { label: string; key?: string }[] = [
    { label: 'Draft' }, { label: 'To collect' }, { label: 'To receive' }, { label: 'In progress', key: 'pending_tests' },
    { label: 'To authorise' }, { label: 'Authorised', key: 'results_approved' }, { label: 'Released' },
  ];
  // "Needs you" (s4): only what the caller must act on; the API scopes the tiles per role. Most urgent first; a 0 or absent tile gives no item.
  const needs = [
    { key: 'pending_overdue', label: 'Overdue', href: '/analytics/reports/pending-tests' },
    { key: 'reports_ready_unreleased', label: 'Ready, not released', href: '/analytics/reports/pending-tests' },
    { key: 'reports_pending', label: 'Reports pending', href: '/analytics/reports/pending-tests' },
  ].filter((n) => (val(dto, n.key)?.value ?? 0) > 0);
  // Money strip (s4/s6): only when the API sent money (it applies the money permissions), always with currency (fmt) and period.
  const moneyCells = ['net_sales_paisa', 'net_collected_paisa'].filter(sent).map((k) => cells[k]!);
  const others = ['patient_visits', 'reports_pending'].filter(sent).map((k) => cells[k]!);
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
      <ol className="lims-stepper-list" aria-label="Sample pipeline">
        {STAGES.map((s) => {
          const c = s.key && sent(s.key) ? cells[s.key]! : undefined;
          return (
            <li key={s.label} className="lims-step">
              {c ? (
                <>
                  {/* the stage link is the filter; the tile inside it is a plain div (StatTile without href) */}
                  <a href={c.href}>
                    <span className="lims-step-label">{s.label}</span>{' '}
                    {tileOf(c, false)}
                  </a>
                  {extras(c)}
                </>
              ) : (
                <span className="lims-step-label">{s.label}</span>
              )}
            </li>
          );
        })}
      </ol>
      <section aria-labelledby={needsId}>
        <h2 id={needsId}>Needs you</h2>
        {needs.length > 0 ? (
          <ul>
            {needs.map((n) => (
              <li key={n.key}>
                <a href={n.href}>
                  {n.label} {fmt(val(dto, n.key)!)}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>Nothing needs you right now.</p>
        )}
      </section>
      {moneyCells.length > 0 ? (
        <section aria-labelledby={moneyId}>
          <h2 id={moneyId}>Money, {period.label_ad}</h2>
          <Inline gap={4} align="start">{moneyCells.map(cell)}</Inline>
        </section>
      ) : null}
      {others.length > 0 ? <Inline gap={4} align="start">{others.map(cell)}</Inline> : null}
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
      ) : moneyCells.length === 0 ? null : (
        // net-sales charts are money: shown only with the money strip (the API sent no money tile = this role may not read money)
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
