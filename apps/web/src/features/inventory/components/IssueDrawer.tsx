'use client';
// S8 Issue stock drawer with the FEFO preview (04-UI-UX §3 S8; AC-08.1, AC-08.2, AC-07.3, AC-07.4, AC-19.4).
// LD-140 (2026-11-13): kit components only; the drawer's Issue is its one primary. The preview is advice: the server re-picks lots at issue time.
// "Auto (FEFO)" is the default lot: the POST then carries NO lot_id and the server splits across lots (one issue movement per lot used).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Drawer } from '@lims/ui/components/Drawer';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { useToast } from '@lims/ui/components/Toast';
import { createIssueAction, fefoAction, listStockAction } from '../server/actions';
import type { BalanceRow, Department, FefoLine, FefoSuggestion, Instrument, IssueCreate, StockDocument } from '../server/types';
import { Chip, expiryState, Pick, ProblemBanner, qtyError, useAttemptKey, type Failure } from './shared';

type Kind = 'department' | 'instrument' | 'general';
const AUTO = 'auto';
const KINDS = [
  { value: 'department', label: 'Department' },
  { value: 'instrument', label: 'Analyser' },
  { value: 'general', label: 'General' },
] as const;

export function IssueDrawer({ storeId, row, departments, instruments, onClose }: { storeId: string; row: BalanceRow | undefined; departments: readonly Department[]; instruments: readonly Instrument[]; onClose: () => void }) {
  return (
    <Drawer title="Issue stock" isOpen={!!row} onClose={onClose}>
      {row ? <IssueForm key={row.item_id} storeId={storeId} row={row} departments={departments} instruments={instruments} onClose={onClose} /> : null}
    </Drawer>
  );
}

function IssueForm({ storeId, row, departments, instruments, onClose }: { storeId: string; row: BalanceRow; departments: readonly Department[]; instruments: readonly Instrument[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const [kind, setKind] = useState<Kind>('department');
  const [departmentId, setDepartmentId] = useState<string>();
  const [instrumentId, setInstrumentId] = useState<string>();
  const [lot, setLot] = useState(AUTO);
  const [lots, setLots] = useState<BalanceRow[]>([]);
  const [qty, setQty] = useState<string>();
  const [errors, setErrors] = useState<{ kind?: string; target?: string; qty?: string }>({});
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<StockDocument>();
  const [preview, setPreview] = useState<FefoSuggestion>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const seq = useRef(0);

  // lot candidates: the balances of this item in this store (server-filtered)
  useEffect(() => {
    let live = true;
    void listStockAction(storeId, row.item_id).then((r) => live && r.ok && setLots(r.data.filter((b) => b.lot_id)));
    return () => {
      live = false;
    };
  }, [storeId, row.item_id]);

  // FEFO preview (#36): debounced, stale answers dropped
  const qtyValid = !qtyError('Qty', qty);
  useEffect(() => {
    if (lot !== AUTO || !qty || !qtyValid) {
      setPreview(undefined);
      setPreviewFailed(false);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void fefoAction(storeId, row.item_id, qty).then((r) => {
        if (mine !== seq.current) return;
        setPreviewFailed(!r.ok);
        setPreview(r.ok ? r.data : undefined);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [storeId, row.item_id, qty, qtyValid, lot]);

  const submit = async () => {
    const e: typeof errors = {};
    if (kind === 'department' && !departmentId) e.target = 'Department is required';
    if (kind === 'instrument' && !instrumentId) e.target = 'Analyser is required';
    const qe = qtyError('Qty', qty);
    if (qe) e.qty = qe;
    setErrors(e);
    if (e.target || e.qty || !qty) return;
    setSaving(true);
    const body: IssueCreate = {
      store_id: storeId,
      issued_to_kind: kind,
      ...(kind === 'department' && departmentId ? { department_id: departmentId } : {}),
      ...(kind === 'instrument' && instrumentId ? { instrument_id: instrumentId } : {}),
      lines: [{ item_id: row.item_id, ...(lot !== AUTO ? { lot_id: lot } : {}), qty }],
    };
    const r = await createIssueAction(body, key.get(JSON.stringify(body)));
    setSaving(false);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    key.reset();
    setDone(r.data);
    toast.show({ tone: 'success', title: `Issued ${r.data.doc_no}` });
    router.refresh();
  };

  if (done) {
    return (
      <Stack>
        <p>{`Issued ${row.item_code} · ${row.item_name}`}</p>
        <ul>
          {done.movements.map((m) => (
            <li key={m.id}>{`${m.lot_no ?? 'No lot'}: ${m.qty_base.replace('-', '')} issued`}</li>
          ))}
        </ul>
        <Button variant="primary" onPress={onClose}>Done</Button>
      </Stack>
    );
  }

  const lotOptions = [{ value: AUTO, label: 'Auto (FEFO)' }, ...lots.map((b) => ({ value: b.lot_id as string, label: `${b.lot_no} (exp ${b.expiry_on ?? '—'}, ${b.available_qty_base} available)` }))];
  const previewCols: ColumnDef<FefoLine>[] = [
    { id: 'lot', header: 'Lot', isRowHeader: true, cell: (l) => l.lot_no },
    { id: 'expiry', header: 'Expiry', cell: (l) => <ExpiryText expiryOn={l.expiry_on} /> },
    { id: 'open', header: 'Open container', cell: (l) => (l.has_open_container ? <Chip tone="info" label="Open" /> : '—') },
    { id: 'take', header: 'Take', align: 'end', cell: (l) => l.take_qty_base },
    { id: 'avail', header: 'Available', align: 'end', cell: (l) => l.available_qty_base },
  ];
  const short = preview && Number(preview.shortfall_qty_base) > 0 ? preview.shortfall_qty_base : undefined;

  return (
    <Stack>
      <p>{`${row.item_code} · ${row.item_name}`}</p>
      <ProblemBanner problem={problem} />
      <RadioGroup label="Issued to" name="issued_to_kind" options={KINDS} value={kind} orientation="horizontal" onChange={(v) => { setKind(v); setErrors({}); }} />
      {kind === 'department' ? (
        <Pick label="Department" name="department_id" isRequired options={departments.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))} value={departmentId} error={errors.target} onChange={setDepartmentId} />
      ) : null}
      {kind === 'instrument' ? (
        <Pick label="Analyser" name="instrument_id" isRequired options={instruments.map((i) => ({ value: i.id, label: `${i.instrument_code} — ${i.display_name}` }))} value={instrumentId} error={errors.target} onChange={setInstrumentId} />
      ) : null}
      <Pick label="Lot" name="lot_id" options={lotOptions} placeholder="Lot: Auto (FEFO)" onChange={setLot} />
      <DecimalField label="Qty" name="qty" decimals={3} allowNegative isRequired {...(qty !== undefined ? { value: qty } : {})} {...(errors.qty ? { error: errors.qty } : {})} onChange={setQty} />
      {lot === AUTO && preview ? (
        <>
          <DataTable caption="FEFO preview" columns={previewCols} rows={preview.lines} getRowId={(l) => l.lot_id} density="compact" emptyState={{ title: 'No stock available for this item.' }} />
          <p className="lims-description">Lots are taken in the order shown: opened containers first, then earliest expiry.</p>
          {short ? <Banner tone="warning" title={`Shortfall: ${short} cannot be covered by the stock on hand`} /> : null}
        </>
      ) : null}
      {previewFailed ? <p className="lims-description">The lot preview could not be loaded. You can still issue; the server picks the lots.</p> : null}
      <Button variant="primary" isLoading={saving} onPress={() => void submit()}>Issue</Button>
    </Stack>
  );
}

/** Expiry date plus its state as words ("Expired", "Expires in 9 days"), never colour alone. */
export function ExpiryText({ expiryOn }: { expiryOn: string | undefined }) {
  const s = expiryState(expiryOn);
  return (
    <>
      <span>{expiryOn ?? '—'}</span>
      {s ? <Chip tone={s.tone} label={s.label} /> : null}
    </>
  );
}
