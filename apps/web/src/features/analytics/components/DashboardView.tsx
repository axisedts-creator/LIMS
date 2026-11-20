'use client';
// S1 Owner dashboard body (03-APP-FLOW §5, 04-UI-UX §2/§3). Client component: the kit (react-aria) is client-only. Props are plain API JSON.
// Copy strings are the 04-UI-UX §11 catalogue values. Centre ids are never rendered (07-SECURITY).
import { useId } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { BarChart } from '@lims/ui/components/BarChart';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FreshnessBadge } from '@lims/ui/components/FreshnessBadge';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { TimeSeriesChart } from '@lims/ui/components/TimeSeriesChart';
import { t } from '@/core/i18n/messages';
import type { DashboardDto, Tile } from '../server/dashboard.server';
import { ScopeBanner } from './ScopeBanner';
import { AutoRefresh, RefreshButton, ShowYesterday } from './DashboardActions';

// T0D-WEBFIX-2 (LD-301): the API label_bs already carries " B.S." (shared-ts formatBs 'display'); add it only when missing.
// Lives here, not in period.ts, because rs-c8.static pins period.ts bytes. Used by ReportView, ReportRunView, ScheduleEditor.
export const bsLabel = (s: string) => (/\bB\.S\.\s*$/.test(s) ? s.trim() : s.trim() + ' B.S.');

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
// C8 04-UI-UX:47 reason copy (same strings as the kit FreshnessBadge tooltip), repeated as the note's title so the reason is readable without hover.
const REASON: Record<string, string> = {
  refresh_lagging: 'Recent changes are still being processed',
  refresh_failed: 'Last update failed — the team has been alerted',
  never_refreshed: 'Not yet calculated',
};
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
    net_sales_paisa: { key: 'net_sales_paisa', label: 'Net sales', href: '/analytics/reports/income', family: 'income', extra: [`Invoiced ${sub(dto, 'invoiced_paisa')}`, `Credit notes ${sub(dto, 'credit_notes_paisa')}`] },
    results_approved: { key: 'results_approved', label: 'Results approved', href: '/analytics/reports/tests-done', family: 'results', extra: [`Tests ordered ${sub(dto, 'tests_ordered')}`] },
    reports_pending: { key: 'reports_pending', label: 'Reports pending', href: '/analytics/reports/pending-tests', family: 'report_backlog', extra: [] },
    pending_tests: { key: 'pending_tests', label: 'Pending tests', href: '/analytics/reports/pending-tests', family: 'report_backlog', extra: [] },
    net_collected_paisa: { key: 'net_collected_paisa', label: 'Cash collected', href: '/analytics/collections', family: 'collections', extra: [] },
  };
  const shown = Object.values(cells).filter((c) => val(dto, c.key));
  // T0D-UIDASH-1, LD-353 template 5: the tile row holds exactly these four tiles in this order (money tiles only when the API sent them).
  const tileCells = ['patient_visits', 'reports_pending', 'net_sales_paisa', 'net_collected_paisa'].filter((k) => val(dto, k)).map((k) => cells[k]!);
  const anyDelta = shown.some((c) => delta(val(dto, c.key)!));
  const empty = Object.values(dto.tiles).every((t) => !t || t.value === 0);
  const sent = (k: string) => shown.some((c) => c.key === k);

  // T0D-UNSLOP-1 (C), LD-353 rules 5/8 and template 5: every tile sits in ONE row of equal cells; one freshness note for the page (header status),
  // no badge per tile (overrides 03-APP-FLOW §5 S1 "stale badge per tile"); sub-values move to one line under the row.
  const tileOf = (c: Cell) => {
    const t = val(dto, c.key)!;
    const d = delta(t);
    // leading space: the kit StatTile puts label and value spans side by side with no text gap, so the link name read "Patient visits12" (kit fix: T0D-UIKIT-1)
    return <StatTile key={c.key} label={c.label} value={` ${fmt(t)}`} href={c.href} {...(d ? { delta: d } : {})} />;
  };
  const subValues = shown.flatMap((c) => (val(dto, c.key)!.unit === 'paisa' ? [] : c.extra));

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
  const moneyLines = moneyCells.flatMap((c) => [`${c.label} ${fmt(val(dto, c.key)!)}`, ...c.extra]);
  const canMoney = moneyCells.length > 0;
  const days = dto.series.days;
  const depts = dto.department_top;
  const status = (
    <>
      <span {...(reason && REASON[reason] ? { title: REASON[reason] } : {})}>
        <FreshnessBadge isStale={stale.length > 0} {...(oldest ? { refreshedAt: oldest } : {})} {...(reason ? { reason } : {})} />
      </span>
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
          <PageHeader title={t('analytics.nav.dashboard')} helpKey="analytics.dashboard" status={status} actions={<RefreshButton />} />
        </>
      )}
      <p>
        {period.label_ad} · {bsLabel(period.label_bs)}
      </p>
      <ScopeBanner scope={dto.scope} />
      {period.timezone !== 'Asia/Kathmandu' ? <Banner tone="info" title="Business days are counted in Nepal time (UTC+05:45)." /> : null}
      {tileCells.length > 0 ? <StatTileRow>{tileCells.map(tileOf)}</StatTileRow> : null}
      {subValues.length > 0 ? <p>{subValues.join(' · ')}</p> : null}
      <ol className="lims-stepper-list" aria-label="Sample pipeline">
        {STAGES.map((s) => {
          const c = s.key && sent(s.key) ? cells[s.key]! : undefined;
          return (
            <li key={s.label} className="lims-step">
              {c ? (
                // the stage link is the filter; its count is plain text (the tile itself lives in the one tile row)
                <a href={c.href}>
                  <span className="lims-step-label">{s.label}</span> {fmt(val(dto, c.key)!)}
                </a>
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
          <p>{moneyLines.join(' · ')}</p>
        </section>
      ) : null}
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
      ) : null}
      {/* T0D-UIDASH-1, LD-353 rule 10: both frames ALWAYS draw, with "No data yet" when the period is empty or the role may not read money
          (the API sent no money tile). The charts then get no money data at all, so no amount or department name leaks. */}
      <div className="lims-dash-charts">
        <ChartCard title="Net sales per day" isEmpty={!canMoney || days.length === 0}>
          <TimeSeriesChart
            title="Net sales per day"
            {...(canMoney ? { unit: 'Rs.' } : {})}
            series={[{ id: 'net', label: 'Net sales', points: canMoney ? days.map((x) => ({ at: x.business_date, value: String(x.net_sales_paisa / 100) })) : [] }]}
          />
        </ChartCard>
        <ChartCard title="Top departments" isEmpty={!canMoney || depts.length === 0}>
          <BarChart
            title="Top departments by net sales"
            {...(canMoney ? { valueFormat: 'money' as const } : {})}
            categories={canMoney ? depts.map((x) => (x.is_multiple ? 'Multiple departments' : x.label)) : []}
            series={[{ id: 'net', label: 'Net sales', values: canMoney ? depts.map((x) => x.net_paisa) : [] }]}
          />
        </ChartCard>
      </div>
    </>
  );
}
