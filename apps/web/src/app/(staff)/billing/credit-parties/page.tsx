// 04-UI-UX §8.6 list.
import { getShellSession } from '@/core/session/server';
import { CreditPartiesList } from '@/features/billing/components/CreditPartiesList';
import { listCreditParties } from '@/features/billing/server/read.server';

export default async function CreditPartiesPage() {
  const [session, { data }] = await Promise.all([getShellSession(), listCreditParties({ limit: 100 })]);
  return <CreditPartiesList parties={data} permissions={session?.actor.permissions ?? []} />;
}
