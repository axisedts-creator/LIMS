// SCR-03 Specimen types & containers — server component via the BFF. 403 → no-access page, other failures → error.tsx.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { SpecimensScreen } from '@/features/catalog/components/SpecimensScreen';
import { listContainers } from '@/features/catalog/server/listContainers.server';
import { listSpecimenTypes } from '@/features/catalog/server/listSpecimenTypes.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function SpecimensPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const r = await orForbidden(() => Promise.all([listSpecimenTypes({ isActive: 'all', limit: 200 }), listContainers({ isActive: 'all', limit: 200 })]));
  if (!r) return <CatalogForbidden />;
  return <SpecimensScreen specimenTypes={r[0].data} containers={r[1].data} permissions={session?.actor.permissions ?? []} />;
}
