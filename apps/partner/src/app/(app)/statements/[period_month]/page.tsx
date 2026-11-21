// C13.T19 PS-2 Statement month — /statements/{period_month} (04-UI-UX PS-2). S2 getPartnerStatement. A malformed month is a 404 and never reaches the API; a month without rows is an empty state (US-12.4).
import { notFound } from 'next/navigation';
import { get } from '@/features/common/api';
import type { StatementMonth } from '@/features/common/types';
import { StatementMonthView } from '@/features/statements/StatementViews';

const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export default async function StatementMonthPage({ params }: { params: Promise<{ period_month: string }> }) {
  const { period_month: month } = await params;
  if (!MONTH.test(month)) notFound();
  const body = await get<{ period_month: string; rows: StatementMonth[] }>(`/v1/partners/statements/${month}`);
  if (!Array.isArray(body.rows)) throw new Error('partner_api_failed');
  return <StatementMonthView month={month} rows={body.rows} />;
}
