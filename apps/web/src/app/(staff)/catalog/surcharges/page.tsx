// SCR-16 Urgent surcharge rules — server component via the BFF; 403 → no-access page.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { SurchargeRulesScreen } from '@/features/catalog/components/SurchargeRulesScreen';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { listPriceLists } from '@/features/catalog/server/listPriceLists.server';
import { listSurchargeRules } from '@/features/catalog/server/listSurchargeRules.server';
import { loadPricedOrderables } from '@/features/catalog/server/pricingPage';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function SurchargesPage() {
  const session = await getShellSession();
  const r = await orForbidden(async () => {
    const rules = (await listSurchargeRules()).data;
    const ids = new Set(rules.flatMap((x) => (x.orderable_id ? [x.orderable_id] : [])));
    const [departments, priceLists, orderables] = await Promise.all([listDepartments({ isActive: 'all', limit: 200 }), listPriceLists({ isActive: 'all', limit: 200 }), ids.size ? loadPricedOrderables(ids) : Promise.resolve([])]);
    return { rules, departments: departments.data, priceLists: priceLists.data, orderables };
  });
  if (!r) return <CatalogForbidden />;
  return <SurchargeRulesScreen {...r} permissions={session?.actor.permissions ?? []} />;
}
