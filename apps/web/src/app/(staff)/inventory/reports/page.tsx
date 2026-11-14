// S17 Reports — server component (route staff.inventory.reports; needs inventory.item.read). ?report=<code> picks the tab (default daily_consumption), then from / to
// (YYYY-MM-DD, default the last 30 days), store, analyser, test, item, within_days (expiry), as_of (valuation).
// Tabs the caller may not use are removed here: "Cost per test" without inventory.cost.read, "Reconciliation" unless GET /identity/me says centre_scope.all (fails closed).
// A failed report is passed to the view as a value (inline error), not thrown. LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { ReportsView } from '@/features/inventory/components/ReportsView';
import { defaultPeriod, toReportQuery, type ReportFilters } from '@/features/inventory/reportQuery';
import { listInstruments, listStores, listTests, soft } from '@/features/inventory/server/read.server';
import { getReport, hasAllCentres, isReportCode, settle } from '@/features/inventory/server/reports.server';
import { REPORT_CODES, type ReportCode } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length <= 64 ? s : undefined;
};

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canCost = perms.includes('inventory.cost.read');
  const canExport = perms.includes('inventory.report.export');

  const allCentres = await hasAllCentres();
  const tabs = REPORT_CODES.filter((c) => (c !== 'cost_per_test' || canCost) && (c !== 'consumption_reconciliation' || allCentres));
  const asked = one(sp['report']);
  const code: ReportCode = isReportCode(asked) && tabs.includes(asked) ? asked : 'daily_consumption';

  const period = defaultPeriod();
  const filters: ReportFilters = {
    from: one(sp['from']) ?? period.from,
    to: one(sp['to']) ?? period.to,
    ...(one(sp['store']) ? { store: one(sp['store']) as string } : {}),
    ...(one(sp['analyser']) ? { analyser: one(sp['analyser']) as string } : {}),
    ...(one(sp['test']) ? { test: one(sp['test']) as string } : {}),
    ...(one(sp['item']) ? { item: one(sp['item']) as string } : {}),
    ...(one(sp['within_days']) ? { within_days: one(sp['within_days']) as string } : {}),
    ...(one(sp['as_of']) ? { as_of: one(sp['as_of']) as string } : {}),
  };

  const [result, stores, instruments, tests] = await Promise.all([
    settle(() => getReport(code, toReportQuery(code, filters))),
    soft(() => listStores().then((r) => r.data), []),
    soft(listInstruments, []),
    soft(listTests, []),
  ]);

  return (
    <ReportsView
      tabs={tabs}
      code={code}
      filters={filters}
      result={result}
      nowIso={new Date().toISOString()}
      stores={stores}
      instruments={instruments}
      tests={tests}
      canCost={canCost}
      canExport={canExport}
    />
  );
}
