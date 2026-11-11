// SCR-02 Departments — server component; data via BFF server functions (02-CONVENTIONS §2.4). 403 → no-access page, other failures → error.tsx.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { DepartmentsList } from '@/features/catalog/components/DepartmentsList';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function DepartmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const r = await orForbidden(() => listDepartments({ isActive: 'all', limit: 200 }));
  if (!r) return <CatalogForbidden />;
  return <DepartmentsList departments={r.data} permissions={session?.actor.permissions ?? []} />;
}
