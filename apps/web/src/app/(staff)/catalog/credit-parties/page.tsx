// SCR-12 Credit parties & affiliations — server component via the BFF; 403 → no-access page.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { CreditPartiesScreen } from '@/features/catalog/components/CreditPartiesScreen';
import { listCreditParties } from '@/features/catalog/server/listCreditParties.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function CreditPartiesPage() {
  const session = await getShellSession();
  const r = await orForbidden(() => listCreditParties({ isActive: 'all', limit: 200 }));
  if (!r) return <CatalogForbidden />;
  return <CreditPartiesScreen creditParties={r.data} permissions={session?.actor.permissions ?? []} />;
}
