// SCR-13 price-list detail — unknown / malformed id → 404; 403 → no-access page.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { PriceListDetail } from '@/features/catalog/components/PriceListDetail';
import { getPriceListDetail } from '@/features/catalog/server/getPriceListDetail.server';
import { loadOwnerLabels } from '@/features/catalog/server/pricingPage';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';

export default async function PriceListPage({ params }: { params: Promise<{ price_list_id: string }> }) {
  const [{ price_list_id }, session] = await Promise.all([params, getShellSession()]);
  const permissions = session?.actor.permissions ?? [];
  const r = await orForbidden(async () => {
    const detail = await orMissing(() => getPriceListDetail(price_list_id));
    return detail && { detail, labels: await loadOwnerLabels(detail, permissions.includes('identity.centre.read')) };
  });
  if (r === null) return <CatalogForbidden />;
  if (!r) notFound();
  return <PriceListDetail priceList={r.detail} ownerLabels={r.labels} permissions={permissions} />;
}
