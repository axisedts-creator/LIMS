// T0D-SALES-1 (LD-321; route staff.partners.sales_designations): ElabAssist Sales Designation. Filters and the cursor come from the URL;
// a failed read keeps the page chrome and shows the ErrorState in the table body (LD-353 rule 6).
import { getShellSession } from '@/core/session/server';
import { listSalesDesignations, loadFailedText, one, settle } from '@/features/partners/server/sales.server';
import { SalesDesignations } from '@/features/partners/components/SalesDesignations';

export const metadata = { title: 'Sales Designation' };

export default async function SalesDesignationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const q = { is_active: one(sp['is_active']), cursor: one(sp['cursor']) };
  const list = permissions.includes('partners.sales.read') ? await settle(listSalesDesignations(q)) : 403;
  const ok = typeof list === 'number' ? undefined : list;
  return (
    <SalesDesignations rows={ok?.data ?? []} failed={ok ? undefined : loadFailedText(list as number)} nextCursor={ok?.page.next_cursor}
      isActive={q.is_active} permissions={permissions} />
  );
}
