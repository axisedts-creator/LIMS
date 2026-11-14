'use client';
// S12 Bench (04-UI-UX §3 S12): technologist screen, tablet-friendly and scan-first. Open containers (finish / discard), open a container,
// log calibration or manual QC. Gate: inventory.bench.record. LD-140 (2026-11-13): kit components only; "Open container" is the ONE primary.
// The client never sends or computes open_expiry_at (the server takes the earlier of open-stability and lot expiry in tenant time),
// and a QC fact multiplier comes from "Observations" (integer 1-50). Back-dating limits are the server's: a 400 shows on "Occurred at" (AC-15.2).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateTimePicker, type DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Dialog } from '@lims/ui/components/Dialog';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { discardContainerAction, finishContainerAction, listAnalytesAction, listStockAction, logConsumptionEventAction, lookupBarcodeAction, openContainerAction } from '../server/actions';
import type { Analyte, BalanceRow, CodedValue, Container, Instrument, ItemSummary, Store, TestRef } from '../server/types';
import { BARCODE_VALUE } from './codes';
import { Chip, fieldMessage, isoDate, Pick, ProblemBanner, qtyError, useAttemptKey, type Failure } from './shared';

export interface BenchViewProps {
  stores: readonly Store[];
  storeId: string;
  containers: readonly Container[];
  items: readonly ItemSummary[];
  instruments: readonly Instrument[];
  tests: readonly TestRef[];
  wastageReasons: readonly CodedValue[];
  calibrationReasons: readonly CodedValue[];
}

export function BenchView(p: BenchViewProps) {
  const router = useRouter();
  const current = p.stores.find((s) => s.id === p.storeId);
  return (
    <section aria-label="Bench">
      <PageHeader title="Bench" helpKey="inventory.bench" />
      <Stack>
        <Pick
          label="Store"
          name="store"
          placeholder={`Store: ${current ? current.name : '—'}`}
          options={p.stores.map((s) => ({ value: s.id, label: `${s.store_code} — ${s.name}` }))}
          onChange={(id) => router.replace(`/inventory/bench?store=${id}`)}
        />
        <OpenContainers {...p} />
        <OpenForm key={`open-${p.storeId}`} {...p} />
        <LogForm {...p} />
      </Stack>
    </section>
  );
}

function OpenContainers({ containers, items, instruments, wastageReasons }: BenchViewProps) {
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const [problem, setProblem] = useState<Failure>();
  const [discarding, setDiscarding] = useState<Container>();
  const [busy, setBusy] = useState<string>();
  const itemName = (id: string) => { const i = items.find((x) => x.id === id); return i ? `${i.item_code} · ${i.name}` : id; };
  const analyser = (id: string | undefined) => (id ? (instruments.find((i) => i.id === id)?.instrument_code ?? id) : '—');

  const finish = async (c: Container) => {
    setBusy(c.id);
    const r = await finishContainerAction(c.id, c.version, key.get(`finish:${c.id}:${c.version}`));
    setBusy(undefined);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    key.reset();
    toast.show({ tone: 'success', title: 'Container finished' });
    router.refresh();
  };

  const columns: ColumnDef<Container>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: (c) => itemName(c.item_id) },
    { id: 'lot', header: 'Lot', cell: (c) => c.lot_no ?? '—' },
    { id: 'analyser', header: 'Analyser', cell: (c) => analyser(c.instrument_id) },
    { id: 'opened', header: 'Opened', cell: (c) => isoDate(c.opened_at) },
    {
      id: 'expiry',
      header: 'Open expiry',
      cell: (c) => (
        <>
          <span>{isoDate(c.open_expiry_at)}</span>
          {c.open_expiry_at && Date.parse(c.open_expiry_at) < Date.now() ? <Chip tone="danger" label="Open expiry passed" /> : null}
        </>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (c) => (
        <Inline gap={1}>
          <Button size="sm" isLoading={busy === c.id} onPress={() => void finish(c)}>Finish</Button>
          <Button size="sm" variant="ghost" onPress={() => setDiscarding(c)}>Discard</Button>
        </Inline>
      ),
    },
  ];
  return (
    <Stack>
      <ProblemBanner problem={problem} />
      <DataTable caption="Open containers" columns={columns} rows={containers} getRowId={(c) => c.id} emptyState={{ title: 'No open containers on this bench' }} />
      {discarding ? (
        <DiscardDialog
          c={discarding}
          reasons={wastageReasons}
          onClose={() => setDiscarding(undefined)}
          onDone={() => {
            setDiscarding(undefined);
            toast.show({ tone: 'success', title: 'Container discarded and the remainder written off' });
            router.refresh();
          }}
        />
      ) : null}
    </Stack>
  );
}

function DiscardDialog({ c, reasons, onClose, onDone }: { c: Container; reasons: readonly CodedValue[]; onClose: () => void; onDone: () => void }) {
  const key = useAttemptKey();
  const [qty, setQty] = useState<string>();
  const [reason, setReason] = useState<string>();
  const [errors, setErrors] = useState<{ qty?: string; reason?: string }>({});
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const e = { ...(qtyError('Remaining qty', qty) ? { qty: qtyError('Remaining qty', qty) as string } : {}), ...(reason ? {} : { reason: 'Reason is required' }) };
    setErrors(e);
    if (e.qty || e.reason || !qty || !reason) return;
    const body = { qty_base: qty, reason_code: reason };
    setSaving(true);
    const r = await discardContainerAction(c.id, c.version, key.get(JSON.stringify(body)), body);
    setSaving(false);
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };
  return (
    <Dialog
      title="Discard container"
      isOpen
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button variant="danger" isLoading={saving} onPress={() => void submit()}>Discard</Button>
        </>
      }
    >
      <Stack>
        <ProblemBanner problem={problem} />
        <DecimalField label="Remaining qty" name="qty_base" decimals={3} allowNegative isRequired {...(qty !== undefined ? { value: qty } : {})} {...(errors.qty ? { error: errors.qty } : {})} onChange={setQty} />
        <Pick label="Reason" name="reason_code" isRequired options={reasons.map((r) => ({ value: r.code, label: r.display }))} value={reason} error={errors.reason} onChange={setReason} />
      </Stack>
    </Dialog>
  );
}

function OpenForm({ storeId, items, instruments }: BenchViewProps) {
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const [item, setItem] = useState<string>();
  const [lot, setLot] = useState<string>();
  const [instrument, setInstrument] = useState<string>();
  const [lots, setLots] = useState<BalanceRow[]>([]);
  const [errors, setErrors] = useState<{ item?: string; lot?: string }>({});
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const chosen = items.find((i) => i.id === item);

  useEffect(() => {
    if (!item) return;
    let live = true;
    setLot(undefined);
    void listStockAction(storeId, item).then((r) => live && setLots(r.ok ? r.data.filter((b) => b.lot_id) : []));
    return () => {
      live = false;
    };
  }, [storeId, item]);

  const onScan = async (value: string) => {
    const r = await lookupBarcodeAction(value); // the scanned value goes in the POST body only, never a URL or a log
    if (!r.ok) return setScanMsg(r.status === 404 ? 'No item has this barcode.' : 'The barcode could not be checked.');
    if (!items.some((i) => i.id === r.data.id)) return setScanMsg('This item is not available here.');
    setScanMsg('');
    setItem(r.data.id);
  };

  const submit = async () => {
    const e = { ...(item ? {} : { item: 'Item is required' }), ...(item && chosen?.is_lot_tracked && !lot ? { lot: 'Lot is required for this item' } : {}) };
    setErrors(e);
    if (e.item || e.lot || !item) return;
    const body = { store_id: storeId, item_id: item, ...(lot ? { lot_id: lot } : {}), ...(instrument ? { instrument_id: instrument } : {}) };
    setSaving(true);
    const r = await openContainerAction(body, key.get(JSON.stringify(body)));
    setSaving(false);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    key.reset();
    toast.show({ tone: 'success', title: 'Container opened' });
    setItem(undefined);
    setLot(undefined);
    setInstrument(undefined);
    router.refresh();
  };

  return (
    <form aria-label="Open container" noValidate onSubmit={(e) => e.preventDefault()}>
      <Stack>
        <h2 className="lims-card-title">Open container</h2>
        <ProblemBanner problem={problem} />
        <BarcodeInput label="Scan item barcode" name="scan" pattern={BARCODE_VALUE} autoFocus={false} onScan={(v) => void onScan(v)} />
        {scanMsg ? <p role="status">{scanMsg}</p> : null}
        <Pick label="Item" name="item_id" isRequired options={items.map((i) => ({ value: i.id, label: `${i.item_code} — ${i.name}` }))} value={item} error={errors.item} onChange={setItem} />
        <Pick label="Lot" name="lot_id" isRequired={!!chosen?.is_lot_tracked} options={lots.map((b) => ({ value: b.lot_id as string, label: `${b.lot_no} (exp ${b.expiry_on ?? '—'}, ${b.available_qty_base} available)` }))} value={lot} error={errors.lot} onChange={setLot} />
        <Pick label="Analyser" name="instrument_id" description="Choose the analyser this bottle is loaded on. Automatic deductions for that analyser use this lot." options={instruments.map((i) => ({ value: i.id, label: `${i.instrument_code} — ${i.display_name}` }))} value={instrument} onChange={setInstrument} />
        <div>
          <Button variant="primary" isLoading={saving} onPress={() => void submit()}>Open container</Button>
        </div>
      </Stack>
    </form>
  );
}

type Kind = 'calibration' | 'qc';
type IsoUtc = NonNullable<DateTimePickerProps['value']>;

function LogForm({ instruments, tests, calibrationReasons }: BenchViewProps) {
  const toast = useToast();
  const key = useAttemptKey();
  const [formKey, setFormKey] = useState(0);
  const [kind, setKind] = useState<Kind>('qc');
  const [instrument, setInstrument] = useState<string>();
  const [test, setTest] = useState<string>();
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [analyte, setAnalyte] = useState<string>();
  const [reason, setReason] = useState<string>();
  const [observations, setObservations] = useState<string | undefined>('1');
  const [occurredAt, setOccurredAt] = useState<string | undefined>(() => new Date().toISOString());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAnalyte(undefined);
    setAnalytes([]);
    if (!test) return;
    let live = true;
    void listAnalytesAction(test).then((r) => live && setAnalytes(r.ok ? r.data : []));
    return () => {
      live = false;
    };
  }, [test]);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (kind === 'calibration' && !instrument) e['instrument'] = 'Analyser is required for a calibration';
    if (!test) e['test'] = 'Test is required';
    if (kind === 'calibration' && !reason) e['reason'] = 'Reason is required for a calibration';
    if (!occurredAt) e['occurredAt'] = 'Occurred at is required';
    else if (Date.parse(occurredAt) > Date.now() + 60_000) e['occurredAt'] = 'Occurred at cannot be in the future';
    const obs = observations === undefined ? NaN : Number(observations);
    if (kind === 'qc' && !(/^\d+$/.test(observations ?? '') && obs >= 1 && obs <= 50)) e['observations'] = 'Observations must be a whole number from 1 to 50';
    setErrors(e);
    if (Object.keys(e).length || !test || !occurredAt) return;
    const body = {
      fact_kind: kind,
      test_id: test,
      occurred_at: occurredAt,
      ...(instrument ? { instrument_id: instrument } : {}),
      ...(analyte ? { analyte_id: analyte } : {}),
      ...(kind === 'qc' ? { observations: obs } : {}),
      ...(kind === 'calibration' && reason ? { reason_code: reason } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setSaving(true);
    const r = await logConsumptionEventAction(body, key.get(JSON.stringify(body)));
    setSaving(false);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    key.reset();
    const n = r.data.movements.length;
    toast.show({ tone: 'success', title: r.data.status === 'no_rule' || n === 0 ? 'Logged. No consumption rule matches, so nothing was deducted.' : `Logged. ${n} item${n === 1 ? '' : 's'} deducted.` });
    setFormKey((k) => k + 1); // fresh form: kind, selections, observations, time and note reset
    setInstrument(undefined);
    setTest(undefined);
    setReason(undefined);
    setObservations('1');
    setOccurredAt(new Date().toISOString());
    setNote('');
  };

  const serverTime = fieldMessage(problem, '/occurred_at');
  return (
    <form key={formKey} aria-label="Log calibration or manual QC" noValidate onSubmit={(e) => e.preventDefault()}>
      <Stack>
        <h2 className="lims-card-title">Log calibration or manual QC</h2>
        <ProblemBanner problem={problem} />
        <RadioGroup label="Kind" name="fact_kind" orientation="horizontal" value={kind} onChange={setKind} options={[{ value: 'calibration', label: 'Calibration' }, { value: 'qc', label: 'QC' }]} />
        <Pick label="Analyser" name="instrument_id" isRequired={kind === 'calibration'} options={instruments.map((i) => ({ value: i.id, label: `${i.instrument_code} — ${i.display_name}` }))} value={instrument} error={errors['instrument']} onChange={setInstrument} />
        <Pick label="Test" name="test_id" isRequired options={tests.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }))} value={test} error={errors['test']} onChange={setTest} />
        <Pick label="Analyte" name="analyte_id" options={analytes.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))} value={analyte} onChange={setAnalyte} />
        {kind === 'calibration' ? <Pick label="Reason" name="reason_code" isRequired options={calibrationReasons.map((r) => ({ value: r.code, label: r.display }))} value={reason} error={errors['reason']} onChange={setReason} /> : null}
        {kind === 'qc' ? <DecimalField label="Observations" name="observations" decimals={0} min="1" max="50" allowNegative isRequired {...(observations !== undefined ? { value: observations } : {})} {...(errors['observations'] ? { error: errors['observations'] } : {})} onChange={setObservations} /> : null}
        <DateTimePicker label="Occurred at" name="occurred_at" isRequired {...(occurredAt ? { value: occurredAt as IsoUtc } : {})} {...(serverTime || errors['occurredAt'] ? { error: (serverTime ?? errors['occurredAt']) as string } : {})} onChange={(v) => setOccurredAt(v)} />
        <TextArea label="Note" name="note" maxLength={500} description="Do not enter patient details." value={note} onChange={setNote} />
        <div>
          <Button isLoading={saving} onPress={() => void submit()}>Log event</Button>
        </div>
      </Stack>
    </form>
  );
}
