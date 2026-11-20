// T0D-SALES-1 (LD-321; route staff.partners.sales_areas): ElabAssist Services In Area. The centre names come from the centre list (no centre = all centres).
import { getShellSession } from '@/core/session/server';
import { listCentreOptions, listServiceAreas, loadFailedText, one, settle } from '@/features/partners/server/sales.server';
import { SalesAreas } from '@/features/partners/components/SalesAreas';

export const metadata = { title: 'Services In Area' };

export default async function SalesAreasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const q = { is_active: one(sp['is_active']), cursor: one(sp['cursor']) };
  const allowed = permissions.includes('partners.sales.read');
  const [list, centres] = allowed ? await Promise.all([settle(listServiceAreas(q)), listCentreOptions()]) : [403, []];
  const ok = typeof list === 'number' ? undefined : list;
  return (
    <SalesAreas rows={ok?.data ?? []} centres={centres} failed={ok ? undefined : loadFailedText(list as number)} nextCursor={ok?.page.next_cursor}
      isActive={q.is_active} permissions={permissions} />
  );
}
