'use client';
// S7 Report run (04-UI-UX §9): header, "as of now" banner, then one read-only Card per report (the same section components as the report pages).
import { Banner } from '@lims/ui/components/Banner';
import { Card } from '@lims/ui/components/Card';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { DashboardDto } from '../server/dashboard.server';
import { DashboardView } from './DashboardView';
import { ReportSections } from './ReportView';
import type { PageVM } from './report-types';

export type RunCard = { id: string; title: string } & ({ vm: PageVM } | { dashboard: DashboardDto; query: string });

export function ReportRunView({ scheduleName, periodAd, periodBs, cards }: { scheduleName: string; periodAd: string; periodBs: string; cards: RunCard[] }) {
  const period = [periodAd, periodBs ? `${periodBs} B.S.` : ''].filter(Boolean).join(' · ');
  return (
    <>
      <PageHeader title={`${scheduleName} — ${period}`} helpKey="analytics.report_run" />
      <Banner tone="info" title="Figures as of now for this period. Your access limits apply." />
      {cards.map((c) => (
        <section key={c.id} aria-label={c.title}>
          <Card title={c.title}>
            {'vm' in c ? <ReportSections vm={c.vm} /> : <DashboardView dto={c.dashboard} query={c.query} readOnly />}
          </Card>
        </section>
      ))}
    </>
  );
}
