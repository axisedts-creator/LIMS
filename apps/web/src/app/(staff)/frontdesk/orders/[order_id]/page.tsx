// 04-UI-UX §4 (route staff.frontdesk.order). Server component: reads through the BFF, hands DTOs to OrderView. 404/400 → notFound(); 5xx → error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { OrderView } from '@/features/frontdesk/components/OrderView';
import { getOrder, getOrderBilling, listCatalogOptions, listCodedSet } from '@/features/frontdesk/server/read.server';
import type { Order } from '@/features/frontdesk/server/types';

export const metadata = { title: 'Order' };

export default async function OrderPage({ params }: { params: Promise<{ order_id: string }> }) {
  const [session, { order_id }] = await Promise.all([getShellSession(), params]);
  const perms = session?.actor.permissions ?? [];
  const has = (p: string) => perms.includes(p);
  let order: Order;
  try {
    order = await getOrder(order_id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound(); // unknown order and another centre's order look the same
    throw e;
  }
  const [billing, cancelReasons, removalReasons, catalogOptions] = await Promise.all([
    has('billing.invoice.read') ? getOrderBilling(order_id).catch((e: unknown) => { if (e instanceof ApiError && e.status === 403) return null; throw e; }) : null,
    has('frontdesk.order.cancel') ? listCodedSet('order_cancel_reasons') : [],
    has('frontdesk.order.edit') ? listCodedSet('item_removal_reasons') : [],
    has('frontdesk.order.edit') ? listCatalogOptions() : [],
  ]);
  return <OrderView order={order} billing={billing} permissions={perms} cancelReasons={cancelReasons} removalReasons={removalReasons} catalogOptions={catalogOptions} />;
}
