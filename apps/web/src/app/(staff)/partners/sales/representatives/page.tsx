// T0D-SALES-1 (LD-321; route staff.partners.sales_representatives): ElabAssist Sales Representative with the manager tree.
// The list is paged (100); the designation names and the tree (with inactive nodes, one page of 200) feed the columns and the pickers.
import { getShellSession } from '@/core/session/server';
import { getSalesTree, listSalesDesignations, listSalesRepresentatives, loadFailedText, one, settle } from '@/features/partners/server/sales.server';
import { SalesRepresentatives } from '@/features/partners/components/SalesRepresentatives';

export const metadata = { title: 'Sales Representative' };

export default async function SalesRepresentativesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const q = { is_active: one(sp['is_active']), cursor: one(sp['cursor']) };
  const allowed = permissions.includes('partners.sales.read');
  const [list, grades, tree] = allowed
    ? await Promise.all([settle(listSalesRepresentatives(q)), settle(listSalesDesignations({}, 200)), settle(getSalesTree())])
    : [403, 403, 403];
  const ok = typeof list === 'number' ? undefined : list;
  return (
    <SalesRepresentatives
      rows={ok?.data ?? []} failed={ok ? undefined : loadFailedText(list as number)} nextCursor={ok?.page.next_cursor}
      designations={typeof grades === 'number' ? [] : grades.data} tree={typeof tree === 'number' ? [] : tree.data}
      isActive={q.is_active} permissions={permissions}
    />
  );
}
