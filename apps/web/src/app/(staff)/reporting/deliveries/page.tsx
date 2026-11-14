// 04-UI-UX §2.5 Delivery log. No routes.yaml row for the list, so the page guards itself (reporting.delivery.read) before any API call.
import { DeliveriesList } from '@/features/reporting/components/DeliveriesList';
import { gate, one } from '@/features/reporting/server/gate.server';
import { listDeliveries } from '@/features/reporting/server/read.server';

export default async function DeliveriesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = (await searchParams) ?? {};
  return gate('reporting.delivery.read', async (permissions) => {
    const r = await listDeliveries({ status: one(sp['status']), channel: one(sp['channel']), purpose: one(sp['purpose']), reportId: one(sp['report_id']), range: one(sp['range']), cursor: one(sp['cursor']) });
    return <DeliveriesList deliveries={r.data} permissions={permissions} nextCursor={r.page.next_cursor} />;
  });
}
