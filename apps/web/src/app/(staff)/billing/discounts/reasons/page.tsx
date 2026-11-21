// T0D-FINCTRL-1 (LD-321; route staff.billing.discount_reasons): ElabAssist Discount Reason master. Gate = billing.discount_policy.read (routes.yaml).
// ponytail: first 200 reasons (contract page maximum, limit=200); add cursor paging when a tenant has more.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { DiscountReasonsScreen } from '@/features/billing/components/discounts/DiscountReasonsScreen';
import { readList } from '@/features/billing/components/listRead';
import { listDiscountReasons } from '@/features/billing/server/discounts.server';

export default async function DiscountReasonsPage() {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('billing.discount_policy.read')) notFound();
  const { value, failure } = await readList(() => listDiscountReasons());
  return <DiscountReasonsScreen reasons={value ?? []} failure={failure} permissions={permissions} />;
}
