// 04-UI-UX §8.6 list. T0D-UILIST-2 (LD-353 rule 6): 501 = NotAvailable with the header row, 500 = ErrorState under the kept title and filters.
import { pendingOr } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { CREDIT_PARTY_COLUMNS, CreditPartiesList } from '@/features/billing/components/CreditPartiesList';
import { readList } from '@/features/billing/components/listRead';
import { listCreditParties } from '@/features/billing/server/read.server';

export default async function CreditPartiesPage() {
  const session = await getShellSession();
  return pendingOr('Credit parties', CREDIT_PARTY_COLUMNS, async () => {
    const { value, failure } = await readList(() => listCreditParties({ limit: 100 }));
    return <CreditPartiesList parties={value?.data ?? []} permissions={session?.actor.permissions ?? []} {...(failure ? { failure } : {})} />;
  });
}
