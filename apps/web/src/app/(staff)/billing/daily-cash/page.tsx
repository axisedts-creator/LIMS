// 04-UI-UX §8.5 (route staff.billing.daily_cash). Date comes from the URL (A.D. IsoDate); default = today on the server.
import { getShellSession } from '@/core/session/server';
import { DailyCashView } from '@/features/billing/components/DailyCashView';
import { getDailyCash, getMyCashSession } from '@/features/billing/server/read.server';
import { ISO_DATE_RE } from '@/features/billing/server/types';

export default async function DailyCashPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const d = typeof sp['date'] === 'string' && ISO_DATE_RE.test(sp['date']) ? sp['date'] : undefined;
  const [report, mine] = await Promise.all([getDailyCash({ ...(d ? { date: d } : {}) }), getMyCashSession()]);
  return <DailyCashView report={report} session={mine} permissions={session?.actor.permissions ?? []} />;
}
