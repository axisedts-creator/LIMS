// S4 Stores + S14 Analyser bindings — server component. ?store=<id> opens the store drawer (404 -> notFound(), e.g. a store of another branch);
// ?tab=analysers opens S14. Analyser labels come from the instrument directory and fall back to ids when it is unavailable.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { StoresView } from '@/features/inventory/components/StoresView';
import { FORBIDDEN, getStore, guarded, listBindings, listBranches, listInstruments, listItems, listItemSettings, listStores, listSuppliers, soft } from '@/features/inventory/server/read.server';
import type { ItemSummary, Store, StoreItemSetting, SupplierSummary } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function StoresPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.master.manage');
  const storeId = one(sp['store']);
  const initialTab = one(sp['tab']) === 'analysers' ? 'analysers' : 'stores';

  const base = await guarded(() => Promise.all([listStores(), listBindings()]));
  if (base === FORBIDDEN) return <PermissionDenied />;
  const [stores, bindings] = base;
  const [branches, instruments] = await Promise.all([canManage ? soft(listBranches, []) : [], soft(listInstruments, [])]);

  let selected: Store | undefined;
  let settings: StoreItemSetting[] = [];
  let items: ItemSummary[] = [];
  let suppliers: SupplierSummary[] = [];
  if (storeId) {
    const r = await guarded(() => Promise.all([getStore(storeId), listItemSettings(storeId), listItems({ isActive: 'true', limit: 200 }), soft(() => listSuppliers(), { data: [], page: { limit: 100 } })]));
    if (r === FORBIDDEN) return <PermissionDenied />;
    selected = r[0];
    settings = r[1].data;
    items = r[2].data;
    suppliers = r[3].data;
  }
  return (
    <StoresView
      key={selected?.id ?? 'none'}
      stores={stores.data}
      canManage={canManage}
      branches={branches}
      bindings={bindings.data}
      instruments={instruments}
      initialTab={initialTab}
      {...(selected ? { selected } : {})}
      settings={settings}
      items={items}
      suppliers={suppliers}
    />
  );
}
