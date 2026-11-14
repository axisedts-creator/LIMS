// SCR-05 Units & value sets — server component via the BFF. 403 → no-access page, other failures → error.tsx.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { UnitsScreen } from '@/features/catalog/components/UnitsScreen';
import { listUnits } from '@/features/catalog/server/listUnits.server';
import { listValueSets } from '@/features/catalog/server/listValueSets.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function UnitsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const r = await orForbidden(() => Promise.all([listUnits({ isActive: 'all' }), listValueSets({ isActive: 'all' })]));
  if (!r) return <CatalogForbidden />;
  return <UnitsScreen units={r[0].data} valueSets={r[1].data} permissions={session?.actor.permissions ?? []} />;
}
