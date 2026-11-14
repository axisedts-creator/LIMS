'use client';
// 04-UI-UX §4.2.4 Stains tab: stain-order table (Stain + kind, On, Status, Requested, Lot, Add-on) with a row-actions menu (Start, Complete, Cancel, Link add-on item),
// [Order stain] dialog (special + IHC only; IHC needs a block), Complete dialog, Cancel (ConfirmDialog, free-text reason required), Link add-on item.
// Writes carry the order's version in If-Match and an Idempotency-Key. People without anatomic.case.work see the table only.
// LD-140 (2026-11-13, binding): kit components only; the page's one primary button stays in the header; statuses show tone, icon and word.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { useToast } from '@lims/ui/components/Toast';
import { startStainAction } from '../../server/actions.material';
import type { CaseDetail, StainOrder, StainOrderStatus } from '../../server/types';
import { Chip, newKey, partName, When, type Fail, type Tone } from '../common';
import { CancelStainDialog, CompleteStainDialog, LinkAddonDialog, OrderStainDialog } from './StainDialogs';

const STATUS: Record<StainOrderStatus, readonly [Tone, string]> = {
  requested: ['info', 'Requested'], in_progress: ['warning', 'In progress'], completed: ['success', 'Completed'], cancelled: ['neutral', 'Cancelled'],
};
type Dialog = { kind: 'order' } | { kind: 'complete' | 'cancel' | 'link'; order: StainOrder } | undefined;

/** Add-on items of the order that no stain order is linked to yet (active, role addon). */
export const unlinkedAddons = (detail: CaseDetail) => {
  const linked = new Set(detail.stain_orders.map((o) => o.addon_order_item_id).filter(Boolean));
  return detail.items.filter((i) => i.role === 'addon' && i.is_active && !linked.has(i.order_item_id));
};

export function StainsTab({ detail, canWork, onFail, onMfa }: { detail: CaseDetail; canWork: boolean; onFail: (f: Fail) => void; onMfa: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>();
  const addons = unlinkedAddons(detail);
  const close = () => setDialog(undefined);
  const done = () => { close(); router.refresh(); };
  const fail = (f: Fail) => (f.code === 'auth.mfa_required' ? onMfa() : onFail(f));

  const actionsOf = (o: StainOrder) => [
    ...(o.status === 'requested' ? [{ id: 'start', label: 'Start' }] : []),
    ...(o.status === 'in_progress' ? [{ id: 'complete', label: 'Complete' }] : []),
    ...(o.status === 'requested' || o.status === 'in_progress' ? [{ id: 'cancel', label: 'Cancel', isDanger: true }] : []),
    ...(o.status !== 'cancelled' && !o.addon_order_item_id && addons.length > 0 ? [{ id: 'link', label: 'Link add-on item' }] : []),
  ];

  const onAction = async (o: StainOrder, id: string) => {
    if (id === 'start') {
      const r = await startStainAction(o.id, o.version, newKey());
      if (r.ok) {
        toast.show({ tone: 'success', title: `${o.stain_display} started` });
        router.refresh();
      } else fail(r);
    } else if (id === 'complete' || id === 'cancel' || id === 'link') setDialog({ kind: id, order: o });
  };

  const addonName = (o: StainOrder) => detail.items.find((i) => i.order_item_id === o.addon_order_item_id)?.test_name ?? '—';
  return (
    <>
      {canWork ? <Button onPress={() => setDialog({ kind: 'order' })}>Order stain</Button> : null}
      <DataTable
        caption="Stain orders"
        density="compact"
        rows={detail.stain_orders}
        getRowId={(o) => o.id}
        emptyState={{ title: 'No special stains or IHC ordered.' }}
        {...(canWork ? { rowActions: actionsOf, onRowActionMenu: (o: StainOrder, id: string) => void onAction(o, id) } : {})}
        columns={[
          { id: 'stain', header: 'Stain', isRowHeader: true, cell: (o) => <>{o.stain_display} <Chip size="sm" tone="neutral" label={o.stain_kind === 'ihc' ? 'IHC' : 'Special'} /></> },
          { id: 'on', header: 'On', cell: (o) => o.block_label ?? partName(detail.parts, o.part_id) },
          { id: 'status', header: 'Status', cell: (o) => <Chip size="sm" tone={STATUS[o.status][0]} label={STATUS[o.status][1]} /> },
          { id: 'requested', header: 'Requested', cell: (o) => <><When value={o.requested_at} time />, {o.requested_by_display_name}</> },
          { id: 'lot', header: 'Lot', cell: (o) => o.reagent_lot ?? '—' },
          { id: 'addon', header: 'Add-on', cell: addonName },
        ]}
      />
      {dialog?.kind === 'order' ? <OrderStainDialog detail={detail} addons={addons} onClose={close} onMfa={onMfa} onDone={done} /> : null}
      {dialog?.kind === 'complete' ? <CompleteStainDialog detail={detail} order={dialog.order} onClose={close} onMfa={onMfa} onDone={done} /> : null}
      {dialog?.kind === 'link' ? <LinkAddonDialog detail={detail} order={dialog.order} addons={addons} onClose={close} onMfa={onMfa} onDone={done} /> : null}
      {dialog?.kind === 'cancel' ? <CancelStainDialog detail={detail} order={dialog.order} onClose={close} onMfa={onMfa} onDone={done} /> : null}
    </>
  );
}
