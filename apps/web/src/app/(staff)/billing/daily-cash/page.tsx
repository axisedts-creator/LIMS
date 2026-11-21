// 04-UI-UX §8.5 (route staff.billing.daily_cash). Date comes from the URL (A.D. IsoDate); default = today on the server.
// T0D-ACCT-2 (LD-313): the ElabAssist Daily Payment Collection summary (getDailyCollectionSummary, totals by payment mode for a centre and day, deposit
// entry) is shown below, only with billing.account.read (no new route). Its centre and day come from ?centre_id= and ?day= (default: first centre, today NPT).
import { getShellSession } from '@/core/session/server';
import { DailyCashView } from '@/features/billing/components/DailyCashView';
import { DailyCollectionScreen } from '@/features/billing/components/transfers/DailyCollectionScreen';
import { listAccountParticulars, listAccountParties } from '@/features/billing/server/accounts.server';
import { getDailyCollectionSummary } from '@/features/billing/server/expenses.server';
import { getDailyCash, getMyCashSession } from '@/features/billing/server/read.server';
import { ISO_DATE_RE, UUID_RE } from '@/features/billing/server/types';

async function collection(sp: Record<string, string | string[] | undefined>, permissions: readonly string[]) {
  if (!permissions.includes('billing.account.read')) return null;
  const [{ centres }, particulars] = await Promise.all([listAccountParties(), listAccountParticulars()]);
  const asked = typeof sp['centre_id'] === 'string' && UUID_RE.test(sp['centre_id']) ? sp['centre_id'] : undefined;
  const centreId = asked ?? centres[0]?.id ?? '';
  const day = typeof sp['day'] === 'string' && ISO_DATE_RE.test(sp['day']) ? sp['day'] : new Date(Date.now() + 345 * 60_000).toISOString().slice(0, 10);
  // T0D-FINCTRL-1 (LD-321): the cash sessions of that centre and day carry Previous Outstanding Cash and Deposit (getDailyCash needs
  // billing.cash_report.read; a refused read passes null and the figures show "—", never invented 0.00 — review fix).
  const [summary, sessions] = centreId
    ? await Promise.all([getDailyCollectionSummary(centreId, day).catch(() => null), getDailyCash({ date: day, centreId }).then((r) => r.sessions ?? [], () => null)])
    : [null, []];
  return { summary, centres, centreId, day, particulars, sessions };
}

export default async function DailyCashPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const d = typeof sp['date'] === 'string' && ISO_DATE_RE.test(sp['date']) ? sp['date'] : undefined;
  const [report, mine, daily] = await Promise.all([getDailyCash({ ...(d ? { date: d } : {}) }), getMyCashSession(), collection(sp, permissions)]);
  return (
    <>
      <DailyCashView report={report} session={mine} permissions={permissions} />
      {daily ? <DailyCollectionScreen {...daily} permissions={permissions} /> : null}
    </>
  );
}
