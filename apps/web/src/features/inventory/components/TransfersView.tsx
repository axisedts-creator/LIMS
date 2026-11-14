'use client';
// S9 Transfers (04-UI-UX §3 S9; AC-10.1 dispatch, AC-10.2 receive with discrepancy, AC-10.3 branch scope, AC-10.4 forbidden transitions).
// LD-140 (2026-11-13): list + right Drawer; "New transfer" is the ONE primary on the list; status = tone + icon + word.
// Receive needs the destination store among the stores this user can see (AC-10.3). The server stays the authority for every transition.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { cancelTransferAction, createTransferAction, dispatchTransferAction, listStockAction, receiveTransferAction } from '../server/actions';
import type { BalanceRow, CodedValue, ItemSummary, Lot, Store, Transfer, TransferCreate, TransferLine, TransferStatus, TransferSummary, TransferTarget } from '../server/types';
import { StockLines, lineErrors, resolveStock, type LineDraft } from './StockLines';
import { Chip, isoDate, Pick, ProblemBanner, qtyError, useAttemptKey, type Failure } from './shared';

const STATUS: Record<TransferStatus, { tone: 'neutral' | 'info' | 'success'; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  dispatched: { tone: 'info', label: 'Dispatched' },
  received: { tone: 'success', label: 'Received' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};
const TransferStatusChip = ({ status }: { status: TransferStatus }) => <Chip tone={STATUS[status]?.tone ?? 'neutral'} label={STATUS[status]?.label ?? status} />;

export interface TransfersViewProps {
  transfers: readonly (TransferSummary & { lines?: readonly unknown[] })[];
  stores: readonly Store[];
  targets: readonly TransferTarget[];
  selected?: Transfer;
  items: readonly ItemSummary[];
  lots: readonly Lot[];
  discrepancyReasons: readonly CodedValue[];
  canManage: boolean;
}

export function TransfersView(p: TransfersViewProps) {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const storeName = (id: string) => p.stores.find((s) => s.id === id)?.name ?? p.targets.find((t) => t.id === id)?.name ?? id;
  const close = () => {
    setCreating(false);
    if (p.selected) router.replace('/inventory/transfers');
  };
  const columns: ColumnDef<TransferViewRow>[] = [
    { id: 'no', header: 'No.', isRowHeader: true, cell: (t) => <a className="lims-link" href={`/inventory/transfers?transfer=${t.id}`}>{t.transfer_no}</a> },
    { id: 'from', header: 'From', cell: (t) => storeName(t.from_store_id) },
    { id: 'to', header: 'To', cell: (t) => storeName(t.to_store_id) },
    { id: 'status', header: 'Status', cell: (t) => <TransferStatusChip status={t.status} /> },
    // ponytail: TransferSummary (contract) carries no line count; "—" until the API adds one
    { id: 'lines', header: 'Lines', align: 'end', cell: (t) => (t.lines ? t.lines.length : '—') },
    { id: 'dispatched', header: 'Dispatched', cell: (t) => isoDate(t.dispatched_at) },
    { id: 'received', header: 'Received', cell: (t) => isoDate(t.received_at) },
  ];
  return (
    <section aria-label="Transfers">
      <PageHeader title="Transfers" helpKey="inventory.transfers" {...(p.canManage ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New transfer</Button> } : {})} />
      <DataTable caption="Transfers" columns={columns} rows={p.transfers} getRowId={(t) => t.id} emptyState={{ title: 'No transfers yet.' }} onRowAction={(t) => router.push(`/inventory/transfers?transfer=${t.id}`)} />
      <Drawer title="New transfer" isOpen={creating} onClose={close}>
        {creating ? (
          <NewTransfer
            stores={p.stores}
            targets={p.targets}
            onDone={(no) => {
              setCreating(false);
              toast.show({ tone: 'success', title: `Transfer ${no} saved as draft` });
              router.refresh();
            }}
          />
        ) : null}
      </Drawer>
      {p.selected ? (
        <Drawer title={`Transfer ${p.selected.transfer_no}`} isOpen onClose={close}>
          <TransferDetail t={p.selected} storeName={storeName} items={p.items} lots={p.lots} reasons={p.discrepancyReasons} canManage={p.canManage} onDone={close} />
        </Drawer>
      ) : null}
    </section>
  );
}
type TransferViewRow = TransferSummary & { lines?: readonly unknown[] };

function NewTransfer({ stores, targets, onDone }: { stores: readonly Store[]; targets: readonly TransferTarget[]; onDone: (no: string) => void }) {
  const key = useAttemptKey();
  const [from, setFrom] = useState<string>();
  const [to, setTo] = useState<string>();
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [errors, setErrors] = useState<{ from?: string; to?: string; none?: string; lines?: Record<number, string> }>({});
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!from) return;
    let live = true;
    setLines([]);
    void listStockAction(from).then((r) => live && setRows(r.ok ? r.data : []));
    return () => {
      live = false;
    };
  }, [from]);

  const submit = async () => {
    const le = lineErrors(lines, rows, false);
    const e = {
      ...(from ? {} : { from: 'From store is required' }),
      ...(to ? {} : { to: 'To store is required' }),
      ...(from && to && from === to ? { to: 'From and To must be different stores' } : {}),
      ...(lines.length ? {} : { none: 'Add at least one line' }),
      ...(Object.keys(le).length ? { lines: le } : {}),
    };
    setErrors(e);
    if (Object.keys(e).length || !from || !to) return;
    const body: TransferCreate = {
      from_store_id: from,
      to_store_id: to,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      lines: lines.map((l) => {
        const b = resolveStock(l, rows)!;
        return { item_id: b.item_id, ...(b.lot_id ? { lot_id: b.lot_id } : {}), qty: l.qty as string };
      }),
    };
    setSaving(true);
    const r = await createTransferAction(body, key.get(JSON.stringify(body)));
    setSaving(false);
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone(r.data.transfer_no);
  };

  return (
    <Stack>
      <ProblemBanner problem={problem} />
      <Pick label="From store" name="from_store_id" isRequired options={stores.map((s) => ({ value: s.id, label: `${s.store_code} — ${s.name}` }))} value={from} error={errors.from} onChange={setFrom} />
      <Pick label="To store" name="to_store_id" isRequired options={targets.map((t) => ({ value: t.id, label: `${t.store_code} — ${t.name} (${t.branch_name})` }))} value={to} error={errors.to} onChange={setTo} />
      <TextArea label="Notes" name="notes" maxLength={1000} value={notes} onChange={setNotes} />
      <StockLines lines={lines} onChange={setLines} rows={rows} errors={errors.lines ?? {}} />
      {errors.none ? <p className="lims-error">{errors.none}</p> : null}
      <div>
        <Button variant="primary" isLoading={saving} onPress={() => void submit()}>Save draft</Button>
      </div>
    </Stack>
  );
}

function TransferDetail({ t, storeName, items, lots, reasons, canManage, onDone }: { t: Transfer; storeName: (id: string) => string; items: readonly ItemSummary[]; lots: readonly Lot[]; reasons: readonly CodedValue[]; canManage: boolean; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const [confirm, setConfirm] = useState<'dispatch' | 'cancel'>();
  const [receiving, setReceiving] = useState(false);
  const [problem, setProblem] = useState<Failure>();
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const lotOf = (id: string | undefined) => lots.find((l) => l.id === id)?.lot_no ?? '—';

  const act = async (kind: 'dispatch' | 'cancel') => {
    const r = await (kind === 'dispatch' ? dispatchTransferAction : cancelTransferAction)(t.id, t.version, key.get(kind));
    setConfirm(undefined);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    key.reset();
    toast.show({ tone: 'success', title: kind === 'dispatch' ? `Transfer ${t.transfer_no} dispatched` : `Transfer ${t.transfer_no} cancelled` });
    router.refresh();
    onDone();
  };

  const columns: ColumnDef<TransferLine>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: (l) => { const i = itemOf(l.item_id); return i ? `${i.item_code} · ${i.name}` : l.item_id; } },
    { id: 'lot', header: 'Lot', cell: (l) => lotOf(l.lot_id) },
    { id: 'qty', header: 'Dispatched qty', align: 'end', cell: (l) => l.qty_base },
    { id: 'recv', header: 'Received qty', align: 'end', cell: (l) => l.received_qty_base ?? '—' },
  ];
  // AC-10.3: branch scope is enforced by the server (403 auth.forbidden -> Banner); the destination is usually outside the sender's visible stores.
  const canReceive = canManage && t.status === 'dispatched';
  return (
    <Stack>
      <ProblemBanner problem={problem} />
      <Inline gap={2}>
        <TransferStatusChip status={t.status} />
        <span>{`${storeName(t.from_store_id)} to ${storeName(t.to_store_id)}`}</span>
      </Inline>
      {t.notes ? <p>{t.notes}</p> : null}
      <DataTable caption="Transfer lines" columns={columns} rows={t.lines} getRowId={(l) => l.id} density="compact" emptyState={{ title: 'No lines.' }} />
      <Inline gap={2}>
        {canManage && t.status === 'draft' ? <Button variant="primary" onPress={() => setConfirm('dispatch')}>Dispatch</Button> : null}
        {canReceive ? <Button variant="primary" onPress={() => setReceiving(true)}>Receive</Button> : null}
        {canManage && t.status === 'draft' ? <Button onPress={() => setConfirm('cancel')}>Cancel</Button> : null}
      </Inline>
      <ConfirmDialog
        title="Dispatch transfer"
        body={`Dispatch? Stock leaves ${storeName(t.from_store_id)} now and shows as in transit.`}
        confirmLabel="Dispatch"
        isOpen={confirm === 'dispatch'}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => act('dispatch')}
      />
      <ConfirmDialog
        title="Cancel transfer"
        body="Cancel this draft transfer? It cannot be dispatched afterwards."
        confirmLabel="Cancel transfer"
        tone="danger"
        isOpen={confirm === 'cancel'}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => act('cancel')}
      />
      {receiving ? <ReceiveDialog t={t} itemOf={itemOf} lotOf={lotOf} reasons={reasons} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); toast.show({ tone: 'success', title: `Transfer ${t.transfer_no} received` }); router.refresh(); onDone(); }} /> : null}
    </Stack>
  );
}

function ReceiveDialog({ t, itemOf, lotOf, reasons, onClose, onDone }: { t: Transfer; itemOf: (id: string) => ItemSummary | undefined; lotOf: (id: string | undefined) => string; reasons: readonly CodedValue[]; onClose: () => void; onDone: () => void }) {
  const key = useAttemptKey();
  const [recv, setRecv] = useState<Record<string, string | undefined>>(() => Object.fromEntries(t.lines.map((l) => [l.id, l.qty_base])));
  const [why, setWhy] = useState<Record<string, string | undefined>>({});
  const [errors, setErrors] = useState<Record<string, { qty?: string; why?: string }>>({});
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const e: typeof errors = {};
    for (const l of t.lines) {
      const q = recv[l.id];
      const qe = qtyError('Received qty', q);
      if (qe) e[l.id] = { qty: qe };
      else if (Number(q) > Number(l.qty_base)) e[l.id] = { qty: 'Received qty cannot be more than the dispatched qty' };
      else if (Number(q) < Number(l.qty_base) && !why[l.id]) e[l.id] = { why: 'A reason is required when less is received' };
    }
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = { lines: t.lines.map((l) => ({ line_id: l.id, received_qty_base: recv[l.id] as string, ...(why[l.id] && Number(recv[l.id]) < Number(l.qty_base) ? { discrepancy_reason_code: why[l.id] as string } : {}) })) };
    setSaving(true);
    const r = await receiveTransferAction(t.id, t.version, key.get(JSON.stringify(body)), body);
    setSaving(false);
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };

  return (
    <Dialog
      title="Receive transfer"
      isOpen
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Close</Button>
          <Button variant="primary" isLoading={saving} onPress={() => void submit()}>Receive</Button>
        </>
      }
    >
      <Stack>
        <ProblemBanner problem={problem} />
        {t.lines.map((l) => {
          const i = itemOf(l.item_id);
          return (
            <Stack key={l.id}>
              <p>{`${i ? `${i.item_code} · ${i.name}` : l.item_id}, lot ${lotOf(l.lot_id)}: dispatched ${l.qty_base}`}</p>
              <DecimalField label="Received qty" name={`recv_${l.id}`} decimals={3} allowNegative {...(recv[l.id] !== undefined ? { value: recv[l.id] as string } : {})} {...(errors[l.id]?.qty ? { error: errors[l.id]?.qty as string } : {})} onChange={(v) => setRecv((s) => ({ ...s, [l.id]: v }))} />
              <Pick label="Discrepancy reason" name={`why_${l.id}`} options={reasons.map((c) => ({ value: c.code, label: c.display }))} value={why[l.id]} error={errors[l.id]?.why} onChange={(v) => setWhy((s) => ({ ...s, [l.id]: v }))} />
            </Stack>
          );
        })}
      </Stack>
    </Dialog>
  );
}
