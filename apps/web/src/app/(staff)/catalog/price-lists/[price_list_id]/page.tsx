// SCR-13 price-list detail — unknown / malformed id → 404; 403 → no-access page.
// T0D-PRICETOOLS-1: also the import history of this list (a 403 on it hides the table only; any other failure goes to error.tsx).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { PriceListDetail } from '@/features/catalog/components/PriceListDetail';
import { getPriceListDetail } from '@/features/catalog/server/getPriceListDetail.server';
import { listPriceListImportBatches } from '@/features/catalog/server/priceTools.server';
import { loadOwnerLabels } from '@/features/catalog/server/pricingPage';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';

export default async function PriceListPage({ params }: { params: Promise<{ price_list_id: string }> }) {
  const [{ price_list_id }, session] = await Promise.all([params, getShellSession()]);
  const permissions = session?.actor.permissions ?? [];
  const r = await orForbidden(async () => {
    const detail = await orMissing(() => getPriceListDetail(price_list_id));
    if (!detail) return undefined;
    const [labels, history] = await Promise.all([
      loadOwnerLabels(detail, permissions.includes('identity.centre.read')),
      orForbidden(async () => (await listPriceListImportBatches(detail.id)).data),
    ]);
    return { detail, labels, history };
  });
  if (r === null) return <CatalogForbidden />;
  if (!r) notFound();
  return <PriceListDetail priceList={r.detail} ownerLabels={r.labels} permissions={permissions} history={r.history} />;
}
