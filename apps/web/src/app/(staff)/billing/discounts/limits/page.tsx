// T0D-FINCTRL-1 (LD-321; route staff.billing.discount_limits): ElabAssist Discount Limit per user. Gate = billing.discount_policy.read (routes.yaml).
// ponytail: first 200 limits and 200 active users (limit=200); add cursor paging when a tenant has more.
import { notFound } from 'next/navigation';
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { DiscountLimitsScreen } from '@/features/billing/components/discounts/DiscountLimitsScreen';
import { readList } from '@/features/billing/components/listRead';
import { listMembers } from '@/features/billing/server/accounts.server';
import { listUserDiscountLimits } from '@/features/billing/server/discounts.server';

export default async function DiscountLimitsPage() {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('billing.discount_policy.read')) notFound();
  const [{ value, failure }, members] = await Promise.all([readList(() => listUserDiscountLimits()), listMembers()]);
  // Review fix: listMembers gives membership ids, the API keys limits on core.users.id; Add New and Edit stay off until CR T0D-FINCTRL-1 is ruled.
  return <DiscountLimitsScreen limits={value ?? []} failure={failure} members={members} permissions={permissions} idPending={t('billing.discounts.reason.user_id_pending')} />;
}
