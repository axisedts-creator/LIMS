// T0D-MISREPORTS-1 (LD-321): Bill Of The Day, route staff.billing.bill_of_the_day, permission analytics.collections.read (definition bill_of_the_day of
// contracts/openapi/analytics.yaml). notFound() before any API call without the permission.
import { requirePermission } from '@/features/analytics/server/reports.server';
import { billOfTheDayPage } from '@/features/analytics/server/mis-page';

export default async function BillOfTheDayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission('analytics.collections.read');
  return billOfTheDayPage(await searchParams);
}
