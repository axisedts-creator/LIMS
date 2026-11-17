// 04-UI-UX §2.3 Outsourced reports queue (staff.reporting.outsourced).
import { OutsourcedQueue } from '@/features/reporting/components/OutsourcedQueue';
import { gate, one } from '@/features/reporting/server/gate.server';
import { listCentres, listOutsourcedItems } from '@/features/reporting/server/read.server';

export default async function OutsourcedPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = (await searchParams) ?? {};
  return gate('reporting.outsourced.attach', async (permissions) => {
    const [items, centres] = await Promise.all([listOutsourcedItems({ state: one(sp['state']), centreId: one(sp['centre_id']) }), listCentres()]);
    return <OutsourcedQueue items={items.data} permissions={permissions} centres={centres} />;
  });
}
