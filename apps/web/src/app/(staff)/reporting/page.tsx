// 04-UI-UX §2.1 Reports worklist + §2.9 Critical alerts panel. The panel failing never fails the worklist (inline alert + Retry).
// The barcode is never read from the URL (PHI in body only, 04-UI-UX §1.2): searchParams carries tab/filters only.
import { CriticalAlertsPanel } from '@/features/reporting/components/CriticalAlertsPanel';
import { ReportsWorklist } from '@/features/reporting/components/ReportsWorklist';
import { gate, one } from '@/features/reporting/server/gate.server';
import { listCentres, listCriticalAlerts, listReports, tabOf } from '@/features/reporting/server/read.server';
import type { CriticalAlert, Page } from '@/features/reporting/server/types';

type SP = Record<string, string | string[] | undefined>;

export default async function ReportingWorklistPage({ searchParams }: { params?: Promise<unknown>; searchParams?: Promise<SP> }) {
  const sp = (await searchParams) ?? {};
  return gate('reporting.report.read', async (permissions) => {
    const centreId = one(sp['centre_id']);
    const tab = tabOf(one(sp['tab']));
    const alertsP: Promise<Page<CriticalAlert> | null> = listCriticalAlerts(centreId).catch(() => null);
    const [reports, alerts, centres] = await Promise.all([
      listReports({ tab, centreId, family: one(sp['family']), registered: one(sp['registered']), review: one(sp['review']), cursor: one(sp['cursor']), sort: one(sp['sort']) }),
      alertsP,
      listCentres(),
    ]);
    return (
      <>
        <CriticalAlertsPanel alerts={alerts ? alerts.data : null} hasMore={!!alerts?.page.next_cursor} centreId={centreId} />
        <ReportsWorklist reports={reports.data} tab={tab} permissions={permissions} centres={centres} nextCursor={reports.page.next_cursor} />
      </>
    );
  });
}
