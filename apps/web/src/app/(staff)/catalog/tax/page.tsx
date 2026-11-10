// SCR-17 Tax rules & tax types — server component via the BFF; 403 → no-access page.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { TaxScreen } from '@/features/catalog/components/TaxScreen';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { listTaxRules } from '@/features/catalog/server/listTaxRules.server';
import { listTaxTypes } from '@/features/catalog/server/listTaxTypes.server';
import { loadPricedOrderables } from '@/features/catalog/server/pricingPage';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function TaxPage() {
  const session = await getShellSession();
  const r = await orForbidden(async () => {
    const [rules, taxTypes, departments] = await Promise.all([listTaxRules(), listTaxTypes(), listDepartments({ isActive: 'all', limit: 200 })]);
    const ids = new Set(rules.data.flatMap((x) => (x.orderable_id ? [x.orderable_id] : [])));
    return { rules: rules.data, taxTypes: taxTypes.data, departments: departments.data, orderables: ids.size ? await loadPricedOrderables(ids) : [] };
  });
  if (!r) return <CatalogForbidden />;
  return <TaxScreen {...r} permissions={session?.actor.permissions ?? []} />;
}
