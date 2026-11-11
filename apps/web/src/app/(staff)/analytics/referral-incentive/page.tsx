// S4 Referral business report (C8 04-UI-UX §5; US-07). Permission analytics.referral_report.read is checked in referralPage before any API call.
import { referralPage } from '@/features/analytics/server/report-page';

export default async function ReferralIncentivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return referralPage(await searchParams);
}
