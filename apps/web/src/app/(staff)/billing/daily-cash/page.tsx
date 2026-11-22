// 04-UI-UX §8.5 (route staff.billing.daily_cash). Date comes from the URL (A.D. IsoDate); default = today on the server.
// T0D-ACCT-2 (LD-313): the ElabAssist Daily Payment Collection summary (getDailyCollectionSummary, totals by payment mode for a centre and day, deposit
// entry) is shown below, only with billing.account.read (no new route). Its centre and day come from ?centre_id= and ?day= (default: first centre, today NPT).
import { ApiError } from '@/core/api/server-fetch';
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { LoadError } from '@/core/shell/LoadError';
import { DailyCashView } from '@/features/billing/components/DailyCashView';
import { DailyCollectionScreen } from '@/features/billing/components/transfers/DailyCollectionScreen';
import { listAccountParticulars, listAccountParties } from '@/features/billing/server/accounts.server';
import { getDailyCollectionSummary } from '@/features/billing/server/expenses.server';
import { getDailyCash, getMyCashSession } from '@/features/billing/server/read.server';
import { ISO_DATE_RE, UUID_RE } from '@/features/billing/server/types';

/** T0D-FIX-11 (LD-455 rule 3): the reference of a failed api read; anything that is not an api failure still throws to error.tsx. */
function refOf(e: unknown): { requestId?: string } {
  if (!(e instanceof ApiError)) throw e;
  return e.problem.request_id ? { requestId: e.problem.request_id } : {};
}

async function collection(sp: Record<string, string | string[] | undefined>, permissions: readonly string[]) {
  if (!permissions.includes('billing.account.read')) return null;
  const [{ centres }, particulars] = await Promise.all([listAccountParties(), listAccountParticulars()]);
  const asked = typeof sp['centre_id'] === 'string' && UUID_RE.test(sp['centre_id']) ? sp['centre_id'] : undefined;
  const centreId = asked ?? centres[0]?.id ?? '';
  const day = typeof sp['day'] === 'string' && ISO_DATE_RE.test(sp['day']) ? sp['day'] : new Date(Date.now() + 345 * 60_000).toISOString().slice(0, 10);
  // T0D-FINCTRL-1 (LD-321): the cash sessions of that centre and day carry Previous Outstanding Cash and Deposit (getDailyCash needs
  // billing.cash_report.read; a refused read passes null and the figures show "—", never invented 0.00 — review fix).
  const [summary, sessions] = centreId
    ? await Promise.all([getDailyCollectionSummary(centreId, day).then((r) => ({ r }), (e: unknown) => ({ r: null, err: refOf(e) })), getDailyCash({ date: day, centreId }).then((r) => r.sessions ?? [], () => null)])
    : [{ r: null }, []];
  // T0D-FIX-11: a failed summary read is the section's inline error with the reference, not an empty summary table
  return { summary: summary.r, ...('err' in summary ? { summaryError: summary.err } : {}), centres, centreId, day, particulars, sessions };
}

export default async function DailyCashPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const d = typeof sp['date'] === 'string' && ISO_DATE_RE.test(sp['date']) ? sp['date'] : undefined;
  const [report, mine, daily] = await Promise.all([getDailyCash({ ...(d ? { date: d } : {}) }).catch((e: unknown) => ({ failed: refOf(e) })), getMyCashSession(), collection(sp, permissions)]);
  if ('failed' in report) return <LoadError title={t('nav.billing.daily_cash')} {...report.failed} />;
  return (
    <>
      <DailyCashView report={report} session={mine} permissions={permissions} />
      {daily ? <DailyCollectionScreen {...daily} permissions={permissions} /> : null}
    </>
  );
}
