// C13.T19 PO-2 Sample detail — /orders/{order_id} (04-UI-UX PO-2; routes.yaml partner.order). O3 getPartnerOrder + A1 /me (access-slip feature flag). Another partner's order is a 404 -> notFound().
import { notFound } from 'next/navigation';
import { get, getMe, isUuid } from '@/features/common/api';
import type { PartnerOrderDetail } from '@/features/common/types';
import { OrderDetail } from '@/features/orders/OrderDetail';

export default async function OrderPage({ params }: { params: Promise<{ order_id: string }> }) {
  const { order_id: id } = await params;
  if (!isUuid(id)) notFound();
  const [order, me] = await Promise.all([get<PartnerOrderDetail>(`/v1/partners/orders/${id}`), getMe()]);
  return <OrderDetail order={order} slips={me.features.access_slip_enabled === true} />;
}
