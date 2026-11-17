// SCR label page, route staff.lab.order_labels (CR-C5-007; 03-APP-FLOW §3.1). The permission list is a UI hint; #14a / #14 enforce it.
// LIMS_LAB_LABEL_WAIT_SECONDS (default 15 [CONV]) is read here, server-side, and passed down; an unusable value falls back to 15.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { LabelPage } from '@/features/lab/components/labels/LabelPage';
import { NO_ACCESS } from '@/features/lab/components/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function waitSeconds(): number {
  const n = Number(process.env.LIMS_LAB_LABEL_WAIT_SECONDS);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : 15;
}

export default async function Page({ params }: { params: Promise<{ order_id: string }> }) {
  const { order_id } = await params;
  if (!UUID.test(order_id)) notFound();
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('lab.specimen.label_print')) return <div className="lims-state"><p className="lims-state-title">{NO_ACCESS}</p></div>;
  return <LabelPage orderId={order_id} waitSeconds={waitSeconds()} permissions={permissions} />;
}
