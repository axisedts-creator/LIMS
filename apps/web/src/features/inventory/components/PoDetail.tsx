'use client';
// S6 detail of a purchase order that is no longer a draft (04-UI-UX §3 S6): lines with Ordered / Received / Open / Closed short, a Timeline,
// and the actions of its state. AC-05.2 (frozen), AC-05.4 mark as sent, AC-05.5 cancel (reason), AC-05.6 close (reason), AC-05.7 forbidden transitions
// come back as a Banner with the registry title and request id. LD-140 (2026-11-13): kit components only; status = tone + icon + word.
// Reasons come from the shared `reasons` coded set, selected by reason_group = po_cancel | po_close (the page loads them).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { Inline } from '@lims/ui/components/Inline';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { TextField } from '@lims/ui/components/TextField';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import { cancelPoAction, closePoAction, markPoSentAction } from '../server/actions';
import type { CodedValue, Item, Po, PoLine, SentChannel, Store, SupplierSummary } from '../server/types';
import { keepKey, money, PoStatusChip, taxText } from './PoShared';
import { Chip, isoDate, ProblemBanner, useAttemptKey, type Failure } from './shared';

const CHANNELS: { value: SentChannel; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'in_person', label: 'In person' },
  { value: 'portal', label: 'Portal' },
  { value: 'other', label: 'Other' },
];
const channelLabel = (c: string | undefined) => CHANNELS.find((x) => x.value === c)?.label ?? c ?? '';

export interface PoDetailProps {
  po: Po;
  items: readonly Item[];
  suppliers: readonly SupplierSummary[];
  stores: readonly Store[];
  taxCodes: readonly CodedValue[];
  perms: readonly string[];
  reasons: { cancel: readonly CodedValue[]; close: readonly CodedValue[] };
  onClose: () => void;
}

export function PoDetail(p: PoDetailProps) {
  const { po } = p;
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const [problem, setProblem] = useState<Failure>();
  const [dialog, setDialog] = useState<'sent' | 'cancel' | 'close'>();
  const canCost = p.perms.includes('inventory.cost.read');
  const manage = p.perms.includes('inventory.po.manage');
  const receive = p.perms.includes('inventory.stock.manage');
  const st = po.status;
  const open = st === 'approved' || st === 'sent';
  const itemOf = (id: string) => p.items.find((i) => i.id === id);
  const packOf = (l: PoLine) => itemOf(l.item_id)?.packs.find((x) => x.id === l.pack_id)?.label ?? l.pack_id;

  const done = (title: string, next?: Po) => {
    setDialog(undefined);
    setProblem(undefined);
    key.reset();
    toast.show({ tone: 'success', title });
    router.refresh();
    if (next) p.onClose();
  };
  const fail = (r: Failure) => {
    setDialog(undefined);
    setProblem(r);
    if (!keepKey(r)) key.reset();
  };
  const reasonAction = async (kind: 'cancel' | 'close', r: { reasonCode?: string; reasonText?: string }) => {
    if (!r.reasonCode) return;
    const b = { reason_code: r.reasonCode, ...(r.reasonText ? { reason_text: r.reasonText } : {}) };
    const res = await (kind === 'cancel' ? cancelPoAction : closePoAction)(po.id, po.version, key.get(`${kind}:${JSON.stringify(b)}`), b);
    if (!res.ok) return fail(res);
    done(kind === 'cancel' ? 'PO cancelled' : 'PO closed', res.data);
  };

  const columns: ColumnDef<PoLine>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: (l) => { const i = itemOf(l.item_id); return i ? `${i.item_code} · ${i.name}` : l.item_id; } },
    { id: 'pack', header: 'Pack', cell: packOf },
    { id: 'ordered', header: 'Ordered', align: 'end', cell: (l) => l.qty_base },
    { id: 'received', header: 'Received', align: 'end', cell: (l) => l.received_qty_base },
    { id: 'open', header: 'Open', align: 'end', cell: (l) => l.open_qty_base },
    { id: 'short', header: 'Closed short', cell: (l) => (l.is_closed_short ? <Chip tone="warning" label="Closed short" /> : '—') },
    ...(canCost
      ? [
          { id: 'price', header: 'Unit price', align: 'end' as const, cell: (l: PoLine) => (l.unit_price_paisa === undefined ? '—' : <MoneyText value={{ amountPaisa: l.unit_price_paisa, currency: 'NPR' }} />) },
          { id: 'tax', header: 'Tax', cell: (l: PoLine) => taxText(l.is_exempt ? undefined : l.tax_code, l.tax_rate_bp, p.taxCodes) },
          { id: 'total', header: 'Line total', align: 'end' as const, cell: (l: PoLine) => (l.line_total_paisa === undefined ? '—' : <MoneyText value={{ amountPaisa: l.line_total_paisa, currency: 'NPR' }} />) },
        ]
      : []),
  ];

  const events = [
    { at: po.created_at, label: 'PO created' },
    ...(po.approved_at ? [{ at: po.approved_at, label: 'PO approved' }] : []),
    ...(po.sent_at ? [{ at: po.sent_at, label: `Marked as sent (${channelLabel(po.sent_channel)}${po.sent_reference ? `, ${po.sent_reference}` : ''})` }] : []),
    ...(po.receipts ?? []).map((g) => ({ at: g.posted_at ?? g.received_at, label: `Receipt ${g.grn_no} (${g.status})` })),
    ...(po.closed_at ? [{ at: po.closed_at, label: 'PO closed' }] : []),
    ...(po.cancelled_at ? [{ at: po.cancelled_at, label: 'PO cancelled', tone: 'warning' as const }] : []),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const supplier = p.suppliers.find((s) => s.id === po.supplier_id);
  const total = money(po.total_paisa);
  return (
    <Stack>
      <ProblemBanner problem={problem} />
      <Inline gap={2}>
        <PoStatusChip status={st} />
        <span>{po.po_no}</span>
      </Inline>
      <DescriptionList
        columns={2}
        items={[
          { term: 'Supplier', value: supplier ? `${supplier.supplier_code} — ${supplier.name}` : po.supplier_id },
          { term: 'Receiving store', value: p.stores.find((x) => x.id === po.store_id)?.name ?? po.store_id },
          { term: 'Expected on', value: isoDate(po.expected_on) },
          ...(canCost && total ? [{ term: 'Total', value: <MoneyText value={total} /> }] : []),
          ...(po.notes ? [{ term: 'Notes', value: po.notes }] : []),
        ]}
      />
      <DataTable caption="Order lines" columns={columns} rows={po.lines} getRowId={(l) => l.id} density="compact" emptyState={{ title: 'No lines.' }} />
      <Timeline items={events} />
      <Inline gap={2}>
        {manage && st === 'approved' ? <Button onPress={() => setDialog('sent')}>Mark as sent</Button> : null}
        {receive && (open || st === 'partially_received') ? <Button onPress={() => router.push(`/inventory/receipts?po=${po.id}`)}>Receive</Button> : null}
        {canCost && open ? <a className="lims-link" href={`/inventory/purchase-orders/${po.id}/print`}>Print</a> : null}
        {manage && open ? <Button onPress={() => setDialog('cancel')}>Cancel</Button> : null}
        {manage && (st === 'partially_received' || st === 'received') ? <Button onPress={() => setDialog('close')}>Close</Button> : null}
      </Inline>
      {dialog === 'sent' ? (
        <MarkSent
          onClose={() => setDialog(undefined)}
          onSubmit={async (b) => {
            const r = await markPoSentAction(po.id, po.version, key.get(`sent:${JSON.stringify(b)}`), b);
            if (!r.ok) return fail(r);
            done('PO marked as sent');
          }}
        />
      ) : null}
      <ConfirmDialog
        title="Cancel purchase order"
        body="Cancel this purchase order? It cannot be received afterwards."
        confirmLabel="Cancel PO"
        tone="danger"
        isOpen={dialog === 'cancel'}
        requireReason={{ codedSet: 'reasons', options: p.reasons.cancel, freeText: { maxLength: 500, isRequired: false } }}
        onCancel={() => setDialog(undefined)}
        onConfirm={(r) => reasonAction('cancel', r)}
      />
      <ConfirmDialog
        title="Close purchase order"
        body="Close this purchase order? Quantities not yet received are closed short."
        confirmLabel="Close PO"
        isOpen={dialog === 'close'}
        requireReason={{ codedSet: 'reasons', options: p.reasons.close, freeText: { maxLength: 500, isRequired: false } }}
        onCancel={() => setDialog(undefined)}
        onConfirm={(r) => reasonAction('close', r)}
      />
    </Stack>
  );
}

function MarkSent({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: { sent_channel: SentChannel; sent_reference?: string }) => Promise<void> }) {
  const [channel, setChannel] = useState<SentChannel>();
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!channel) return setError('Channel is required');
    setError(undefined);
    setSaving(true);
    await onSubmit({ sent_channel: channel, ...(reference.trim() ? { sent_reference: reference.trim() } : {}) });
    setSaving(false);
  };
  return (
    <Dialog
      title="Mark as sent"
      isOpen
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Close</Button>
          <Button variant="primary" isLoading={saving} onPress={() => void submit()}>Mark as sent</Button>
        </>
      }
    >
      <Stack>
        <RadioGroup label="Channel" name="sent_channel" isRequired orientation="horizontal" options={CHANNELS} {...(channel ? { value: channel } : {})} {...(error ? { error } : {})} onChange={setChannel} />
        <TextField label="Reference" name="sent_reference" maxLength={120} value={reference} onChange={setReference} />
      </Stack>
    </Dialog>
  );
}
