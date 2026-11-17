// SCR-04 Methods — server component via the BFF. 403 → no-access page, other failures → error.tsx.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { MethodsList } from '@/features/catalog/components/MethodsList';
import { listMethods } from '@/features/catalog/server/listMethods.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function MethodsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const r = await orForbidden(() => listMethods({ isActive: 'all', limit: 200 }));
  if (!r) return <CatalogForbidden />;
  return <MethodsList methods={r.data} permissions={session?.actor.permissions ?? []} />;
}
