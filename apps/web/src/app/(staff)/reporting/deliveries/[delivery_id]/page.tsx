// 04-UI-UX §2.5 / routes.yaml staff.reporting.delivery.
import { DeliveryDetail } from '@/features/reporting/components/DeliveryDetail';
import { gate } from '@/features/reporting/server/gate.server';
import { getDelivery } from '@/features/reporting/server/read.server';

export default async function DeliveryDetailPage({ params }: { params: Promise<{ delivery_id: string }> }) {
  const { delivery_id } = await params;
  return gate('reporting.delivery.read', async (permissions) => <DeliveryDetail delivery={await getDelivery(delivery_id)} permissions={permissions} />);
}
