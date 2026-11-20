// SCR-13 Price lists — server component via the BFF; 403 → no-access page.
// T0D-PRICETOOLS-1 (LD-321): ?view=compare&a=<version id>&b=<version id> is the Compare price lists view of this route (no new route). Only two
// different well-formed ids are sent; a 404 / 400 of the comparison is shown with the server's text, 403 is the no-access page, the rest goes to error.tsx.
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { PriceCompare, type CompareState } from '@/features/catalog/components/PriceCompare';
import { PriceListsList } from '@/features/catalog/components/PriceListsList';
import { listPriceLists } from '@/features/catalog/server/listPriceLists.server';
import { comparePriceLists, type PriceComparisonRow } from '@/features/catalog/server/priceTools.server';
import { orForbidden } from '@/features/catalog/server/shared';
import { UUID_RE } from '@/features/catalog/server/types';

type Search = Record<string, string | string[] | undefined>;
const idOf = (v: string | string[] | undefined) => (typeof v === 'string' && UUID_RE.test(v) ? v : undefined);

export default async function PriceListsPage({ searchParams }: { searchParams?: Promise<Search> } = {}) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams ?? Promise.resolve<Search>({})]);
  const permissions = session?.actor.permissions ?? [];
  if (sp['view'] === 'compare') {
    const a = idOf(sp['a']);
    const b = idOf(sp['b']);
    const state: CompareState = !a || !b ? 'incomplete' : a === b ? 'same' : 'ready';
    const r = await orForbidden(async () => {
      const lists = (await listPriceLists({ isActive: 'all', limit: 200 })).data;
      if (state !== 'ready') return { lists, rows: [] as PriceComparisonRow[] };
      try {
        const page = await comparePriceLists(a!, b!);
        return { lists, rows: page.data, next: page.page.next_cursor };
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return { lists, rows: [] as PriceComparisonRow[], fail: typeof e.problem.detail === 'string' ? e.problem.detail : e.problem.title };
        throw e;
      }
    });
    if (!r) return <CatalogForbidden />;
    return <PriceCompare key={`${a}-${b}`} lists={r.lists} a={a} b={b} state={state} rows={r.rows} next={'next' in r ? r.next : undefined} fail={'fail' in r ? r.fail : undefined} />;
  }
  const r = await orForbidden(() => listPriceLists({ isActive: 'all', limit: 200 }));
  if (!r) return <CatalogForbidden />;
  return <PriceListsList priceLists={r.data} permissions={permissions} />;
}
