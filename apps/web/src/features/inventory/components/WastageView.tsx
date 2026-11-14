'use client';
// S10 Wastage | Adjustment | Expiry write-off (04-UI-UX §3 S10; AC-11.1, AC-11.2, AC-11.3). LD-140 (2026-11-13): kit components only,
// ONE primary per tab. Adjustment needs inventory.stock.adjust and a fresh second factor (aal2): auth.mfa_required keeps the form and its values.
// The server is the authority for reasons, quantities and expiry; the client only stops input the API would reject anyway.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { createAdjustmentAction, createExpiryWriteoffAction, createWastageAction } from '../server/actions';
import type { BalanceRow, CodedValue, Store } from '../server/types';
import { lineErrors, resolveStock, StockLines, type LineDraft } from './StockLines';
import { ExpiryText } from './IssueDrawer';
import { fieldMessage, ProblemBanner, useAttemptKey, type Failure } from './shared';

export interface WastageViewProps {
  stores: readonly Store[];
  storeId: string;
  balances: readonly BalanceRow[];
  expired: readonly BalanceRow[];
  wastageReasons: readonly CodedValue[];
  adjustmentReasons: readonly CodedValue[];
  canAdjust: boolean;
}

export function WastageView(p: WastageViewProps) {
  const router = useRouter();
  const [tab, setTab] = useState('wastage');
  const tabs = [{ id: 'wastage', label: 'Wastage' }, ...(p.canAdjust ? [{ id: 'adjustment', label: 'Adjustment' }] : []), { id: 'expiry', label: 'Expiry write-off' }];
  return (
    <section aria-label="Wastage and adjustments">
      <PageHeader title="Wastage and adjustments" helpKey="inventory.wastage" />
      <Stack>
        <Select label="Store" name="store" value={p.storeId} options={p.stores.map((s) => ({ value: s.id, label: `${s.store_code} — ${s.name}` }))} onChange={(id) => router.replace(`/inventory/wastage?store=${id}`)} />
        <Tabs items={tabs} selectedId={tab} onChange={setTab} aria-label="Stock write-downs">
          {tab === 'wastage' ? <LinesForm kind="wastage" {...p} /> : tab === 'adjustment' ? <LinesForm kind="adjustment" {...p} /> : <ExpiryWriteoff storeId={p.storeId} rows={p.expired} />}
        </Tabs>
      </Stack>
    </section>
  );
}

function LinesForm({ kind, storeId, balances, wastageReasons, adjustmentReasons }: WastageViewProps & { kind: 'wastage' | 'adjustment' }) {
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const adjust = kind === 'adjustment';
  const reasons = adjust ? adjustmentReasons : wastageReasons;
  const [reason, setReason] = useState<string>();
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [errors, setErrors] = useState<{ reason?: string; lines?: Record<number, string>; none?: string }>({});
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const le = lineErrors(lines, balances, adjust);
    const e = { ...(reason ? {} : { reason: 'Reason is required' }), ...(lines.length ? {} : { none: 'Add at least one line' }), ...(Object.keys(le).length ? { lines: le } : {}) };
    setErrors(e);
    if (Object.keys(e).length || !reason) return;
    const mapped = lines.map((l) => {
      const b = resolveStock(l, balances)!;
      return { item_id: b.item_id, ...(b.lot_id ? { lot_id: b.lot_id } : {}), qty: l.qty as string };
    });
    setSaving(true);
    const r = adjust
      ? await (() => {
          const body = { store_id: storeId, reason_code: reason, ...(note.trim() ? { reason_text: note.trim() } : {}), lines: mapped.map((m, i) => ({ ...m, direction: lines[i]!.direction ?? ('in' as const) })) };
          return createAdjustmentAction(body, key.get(JSON.stringify(body)));
        })()
      : await (() => {
          const body = { store_id: storeId, reason_code: reason, ...(note.trim() ? { reason_text: note.trim() } : {}), lines: mapped };
          return createWastageAction(body, key.get(JSON.stringify(body)));
        })();
    setSaving(false);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    key.reset();
    setLines([]);
    setReason(undefined);
    setNote('');
    toast.show({ tone: 'success', title: `${adjust ? 'Adjustment' : 'Wastage'} ${r.data.doc_no} recorded` });
    router.refresh();
  };

  return (
    <Stack>
      <ProblemBanner problem={problem} />
      <CodedSelect label="Reason" name="reason_code" codedSet={adjust ? 'adjustment' : 'wastage'} isRequired options={reasons.map((c) => ({ code: c.code, display: c.display, isActive: true }))} {...(reason ? { value: reason } : {})} {...(errors.reason ? { error: errors.reason } : {})} onChange={setReason} />
      <TextArea label="Note" name="reason_text" maxLength={500} value={note} onChange={setNote} />
      <StockLines lines={lines} onChange={setLines} rows={balances} withDirection={adjust} errors={errors.lines ?? {}} />
      {errors.none ? <p className="lims-error">{errors.none}</p> : null}
      <div>
        <Button variant="primary" isLoading={saving} onPress={() => void submit()}>{adjust ? 'Post adjustment' : 'Record wastage'}</Button>
      </div>
    </Stack>
  );
}

function ExpiryWriteoff({ storeId, rows }: { storeId: string; rows: readonly BalanceRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const lots = rows.filter((b) => b.lot_id);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<Failure>();
  const [lotErrors, setLotErrors] = useState<Record<string, string>>({});
  const chosen = lots.filter((b) => selected.has(b.lot_id as string));

  const confirm = async () => {
    const lotIds = chosen.map((b) => b.lot_id as string);
    const body = { store_id: storeId, lot_ids: lotIds };
    const r = await createExpiryWriteoffAction(body, key.get(JSON.stringify(body)));
    setOpen(false);
    if (!r.ok) {
      setProblem(r);
      setLotErrors(Object.fromEntries(lotIds.flatMap((id, i) => { const m = fieldMessage(r, `/lot_ids/${i}`); return m ? [[id, m]] : []; })));
      return;
    }
    setProblem(undefined);
    setLotErrors({});
    key.reset();
    setSelected(new Set());
    toast.show({ tone: 'success', title: `Expiry write-off ${r.data.doc_no} recorded` });
    router.refresh();
  };

  const columns: ColumnDef<BalanceRow>[] = [
    { id: 'code', header: 'Item code', isRowHeader: true, cell: (b) => b.item_code },
    { id: 'item', header: 'Item', cell: (b) => b.item_name },
    { id: 'lot', header: 'Lot', cell: (b) => <><span>{b.lot_no}</span>{lotErrors[b.lot_id as string] ? <span className="lims-error">{lotErrors[b.lot_id as string]}</span> : null}</> },
    { id: 'expiry', header: 'Expiry', cell: (b) => <ExpiryText expiryOn={b.expiry_on} /> },
    { id: 'qty', header: 'Qty', align: 'end', cell: (b) => b.qty_base },
  ];
  return (
    <Stack>
      <ProblemBanner problem={problem} />
      <DataTable
        caption="Expired lots with stock"
        columns={columns}
        rows={lots}
        getRowId={(b) => b.lot_id as string}
        selection={{ mode: 'multiple', selectedIds: selected, onChange: setSelected }}
        emptyState={{ title: 'No expired stock in this store.' }}
      />
      <div>
        <Button variant="danger" isDisabled={chosen.length === 0} onPress={() => setOpen(true)}>Write off selected</Button>
      </div>
      <ConfirmDialog
        title="Write off expired stock"
        body={`Write off all remaining stock of ${chosen.length} expired ${chosen.length === 1 ? 'lot' : 'lots'}?`}
        confirmLabel="Write off"
        tone="danger"
        isOpen={open}
        onCancel={() => setOpen(false)}
        onConfirm={confirm}
      />
    </Stack>
  );
}
