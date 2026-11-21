'use client';
// S1 Owner dashboard body = "Today" (03-APP-FLOW §5, 04-UI-UX §2/§3). Client component: the kit (react-aria) is client-only. Props are plain API JSON.
// T0D-UIDASH-2 (LD-436 look, LD-437 exact mock, LD-438 card surface): PageHeader / Card "Where the samples are" (StatusStepper) /
// Card "Needs you" (ActionList) beside Card "Money" (StatTile cells, MoneyText, collected of billed bar) / ChartCard "Billed per day" beside
// ChartCard "Tests by department". Display only: same DTO, routes and permissions. A block whose data the contract does not carry says "Not available yet".
// Centre ids are never rendered (07-SECURITY).
import type { ReactNode } from 'react';
import { ActionList, type ActionListItem } from '@lims/ui/components/ActionList';
import { Banner } from '@lims/ui/components/Banner';
import { Card } from '@lims/ui/components/Card';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FreshnessBadge } from '@lims/ui/components/FreshnessBadge';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile } from '@lims/ui/components/StatTile';
import { StatusStepper, type StatusStep } from '@lims/ui/components/StatusStepper';
import { t } from '@/core/i18n/messages';
import type { DashboardDto, Tile } from '../server/dashboard.server';
import { ScopeBanner } from './ScopeBanner';
import { AutoRefresh, DashboardPeriod, RefreshButton, ShowYesterday } from './DashboardActions';

// T0D-WEBFIX-2 (LD-301): the API label_bs already carries " B.S." (shared-ts formatBs 'display'); add it only when missing.
// Lives here, not in period.ts, because rs-c8.static pins period.ts bytes. Used by ReportView, ReportRunView, ScheduleEditor.
export const bsLabel = (s: string) => (/\bB\.S\.\s*$/.test(s) ? s.trim() : s.trim() + ' B.S.');

const NUM = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const RS = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu' });
const money = (paisa: number) => `Rs. ${RS.format(paisa / 100)}`;
const fmt = (t: Tile) => (t.unit === 'paisa' ? money(t.value) : NUM.format(t.value));
const npr = (paisa: number) => <MoneyText value={{ amountPaisa: paisa, currency: 'NPR' }} />;
// LD-436: a value the contract does not carry is never invented (done_when: NotAvailable, gap in the notes)
const NA = <span className="lims-na">Not available yet</span>;

function delta(t: Tile, caption: string): { value: string; direction: 'up' | 'down' | 'flat'; isGood: boolean } | undefined {
  if (t.delta === undefined) return undefined;
  const direction = t.delta > 0 ? 'up' : t.delta < 0 ? 'down' : 'flat';
  const abs = Math.abs(t.delta);
  const sign = t.delta > 0 ? '+' : t.delta < 0 ? '-' : '';
  const pct = t.delta_bp === undefined ? '' : ` (${(Math.abs(t.delta_bp) / 100).toFixed(1)}%)`;
  return { value: `${sign}${t.unit === 'paisa' ? money(abs) : NUM.format(abs)}${pct} ${caption}`, direction, isGood: direction !== 'down' };
}

// C8 04-UI-UX:47 reason copy (same strings as the kit FreshnessBadge tooltip), repeated as the note's title so the reason is readable without hover.
const REASON: Record<string, string> = {
  refresh_lagging: 'Recent changes are still being processed',
  refresh_failed: 'Last update failed — the team has been alerted',
  never_refreshed: 'Not yet calculated',
};
const PENDING = '/analytics/reports/pending-tests';

/** readOnly = embedded in a report run card (04-UI-UX §9): no page header, auto-refresh, refresh, period or "show yesterday" actions. */
export function DashboardView({ dto, query, readOnly = false }: { dto: DashboardDto; query: string; readOnly?: boolean }) {
  const { period, freshness } = dto;
  const tile = (k: string) => dto.tiles[k];
  const count = (k: string) => tile(k)?.value ?? 0;
  const stale = freshness.filter((f) => f.is_stale);
  const oldest = freshness.map((f) => f.refreshed_at).filter((x): x is string => !!x).sort()[0];
  const reason = stale[0]?.stale_reason;
  const caption = period.days === 1 ? 'vs yesterday' : `vs previous ${period.days} days`;
  const empty = Object.values(dto.tiles).every((x) => !x || x.value === 0);

  // LD-353 rule 8: one freshness note for the page (header status), none inside the cards.
  const status = (
    <>
      <span {...(reason && REASON[reason] ? { title: REASON[reason] } : {})}>
        <FreshnessBadge isStale={stale.length > 0} {...(oldest ? { refreshedAt: oldest } : {})} {...(reason ? { reason } : {})} />
      </span>
      {stale.length > 0 && oldest ? <span> Updated {WHEN.format(Date.parse(oldest))}</span> : null}
    </>
  );

  // Pipeline (LD-140, LD-436): the six stages of the mock. Only stages with an API tile get a count (RS-C8-ruling: In testing = pending_tests,
  // Verified = results_approved); the others show the label only (no invented 0). The lime marker goes on In testing, the one waiting stage,
  // only when something waits; overdue (pending_overdue) is the danger note beside its count.
  const waiting = count('pending_tests') > 0;
  const overdue = count('pending_overdue');
  const steps: StatusStep[] = [
    { id: 'registered', label: 'Registered' },
    { id: 'collected', label: 'Collected' },
    { id: 'received', label: 'Received' },
    {
      id: 'testing', label: 'In testing',
      ...(tile('pending_tests') ? { count: fmt(tile('pending_tests')!) } : {}),
      ...(overdue > 0 ? { note: { text: `${NUM.format(overdue)} overdue`, tone: 'danger' as const } } : {}),
    },
    { id: 'verified', label: 'Verified', ...(tile('results_approved') ? { count: fmt(tile('results_approved')!) } : {}) },
    { id: 'released', label: 'Released' },
  ];

  // "Needs you" (s4): only what the caller must act on; the API scopes the tiles per role. Most urgent first; a 0 or absent tile gives no row.
  const needs: ActionListItem[] = [
    { id: 'pending_overdue', title: 'Overdue', detail: 'Past the turnaround time', tone: 'danger' as const, icon: 'warning' as const, href: PENDING },
    { id: 'reports_ready_unreleased', title: 'Ready, not released', detail: 'Approved, waiting for release', tone: 'success' as const, icon: 'success' as const, href: PENDING },
    { id: 'reports_pending', title: 'Reports pending', detail: 'Waiting for results', tone: 'warning' as const, icon: 'current' as const, href: PENDING },
  ].filter((n) => count(n.id) > 0).map((n) => ({ ...n, count: count(n.id) }));

  // Money (s4/s6): only when the API sent money (it applies the money permissions). Billed = invoiced_paisa, Collected = net_collected_paisa.
  // Outstanding and Cash in drawer have no field in the dashboard contract: "Not available yet".
  const billed = tile('invoiced_paisa');
  const collected = tile('net_collected_paisa');
  const canMoney = ['net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'net_collected_paisa'].some((k) => tile(k));
  const cell = (label: string, t: Tile | undefined) => {
    const d = t ? delta(t, caption) : undefined;
    return <StatTile key={label} label={label} value={t ? npr(t.value) : NA} {...(d ? { delta: d } : {})} />;
  };
  const pct = billed && collected ? (billed.value > 0 ? Math.round((collected.value * 100) / billed.value) : 0) : undefined;

  const days = dto.series.days;
  const block = (children: ReactNode) => <p className="lims-chart-empty">{children}</p>;

  return (
    <>
      {readOnly ? (
        <div>{status}</div>
      ) : (
        <>
          <AutoRefresh />
          <PageHeader
            title={t('analytics.nav.dashboard')}
            helpKey="analytics.dashboard"
            caption={`${period.label_ad} · ${bsLabel(period.label_bs)}`}
            status={status}
            actions={
              <>
                <DashboardPeriod from={period.business_date_from} to={period.business_date_to} query={query} />
                <RefreshButton />
                <a className="lims-btn lims-btn-primary" href="/frontdesk/registrations/new">New registration</a>
              </>
            }
          />
        </>
      )}
      {readOnly ? <p className="lims-page-caption">{period.label_ad} · {bsLabel(period.label_bs)}</p> : null}
      <ScopeBanner scope={dto.scope} />
      {period.timezone !== 'Asia/Kathmandu' ? <Banner tone="info" title="Business days are counted in Nepal time (UTC+05:45)." /> : null}
      {empty ? (
        <>
          <EmptyState title="No activity in this period" />
          {readOnly ? null : <ShowYesterday from={period.business_date_from} query={query} />}
        </>
      ) : null}
      <div className="lims-dash">
        <Card title="Where the samples are" caption={waiting ? 'The most waiting is in testing' : 'Nothing is waiting'}>
          <StatusStepper steps={steps} currentId={waiting ? 'testing' : ''} {...(waiting ? { mostWaitingId: 'testing' } : {})} />
        </Card>
        <div className="lims-dash-row">
          <Card title="Needs you" caption={`${needs.length} ${needs.length === 1 ? 'thing' : 'things'} waiting`}>
            {needs.length > 0 ? <ActionList items={needs} label="Needs you" /> : <p className="lims-card-note">Nothing needs you right now.</p>}
          </Card>
          {canMoney ? (
            <Card title={`Money, ${period.label_ad}`} caption="Amounts in NPR">
              <div className="lims-dash-money">
                {cell('Billed', billed)}
                {cell('Collected', collected)}
                <StatTile label="Outstanding" value={NA} />
                <StatTile label="Cash in drawer" value={NA} />
              </div>
              {pct !== undefined ? (
                <div className="lims-dash-ratio">
                  <span className="lims-dash-ratio-label">
                    <span>Collected of billed</span> <span>{pct}%</span>
                  </span>
                  <progress className="lims-progress" value={Math.min(100, Math.max(0, pct))} max={100} aria-label="Collected of billed" aria-valuetext={`${pct}%`} />
                </div>
              ) : null}
              <p className="lims-card-note">Billed = invoices issued (incl. VAT/other tax). Cash collected is shown separately.</p>
            </Card>
          ) : null}
        </div>
        {/* LD-353 rule 10: both frames ALWAYS draw; neither carries money data, so no amount or department name leaks. */}
        <div className="lims-dash-charts">
          {/* RULING T0D-UIDASH-2 (items 1-3, 6): the contract has no invoiced per day (series carries net_sales_paisa, which is not "Billed"),
              so the mock title stays and the frame says "Not available yet"; no money is drawn here. */}
          <ChartCard title="Billed per day" period={days.length === 1 ? '1 day' : `Last ${days.length} days`}>
            {NA}
          </ChartCard>
          {/* the contract has no test count per department (department_top is net sales money): not invented */}
          <ChartCard title="Tests by department" period={period.label_ad}>
            {block('Not available yet')}
          </ChartCard>
        </div>
      </div>
    </>
  );
}
