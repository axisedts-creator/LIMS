// T0D-FINCTRL-1 (LD-321; route staff.billing.discount_authorities): ElabAssist Discount Authority. Gate = billing.discount_policy.read (routes.yaml).
// ponytail: first 200 authorities and 200 active users (limit=200); add cursor paging when a tenant has more.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { DiscountAuthoritiesScreen } from '@/features/billing/components/discounts/DiscountAuthoritiesScreen';
import { readList } from '@/features/billing/components/listRead';
import { listMembers } from '@/features/billing/server/accounts.server';
import { listDiscountAuthorities } from '@/features/billing/server/discounts.server';

export default async function DiscountAuthoritiesPage() {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('billing.discount_policy.read')) notFound();
  const [{ value, failure }, members] = await Promise.all([readList(() => listDiscountAuthorities()), listMembers()]);
  return <DiscountAuthoritiesScreen authorities={value ?? []} failure={failure} members={members} permissions={permissions} />;
}
