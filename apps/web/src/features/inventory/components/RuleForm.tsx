'use client';
// S13 create form + dry-run preview (04-UI-UX §3 S13; TRD #70 create, #74 preview; AC-12.1, AC-12.6, AC-12.7, AC-12.9, AC-14.2).
// LD-140 (2026-11-13): kit components only; the Drawer holds the form, Save is its one primary button, Preview is secondary.
// The quantity is entered in the base unit or one pack of the item; the server converts (qty + pack_id) and never trusts a client total.
import { useEffect, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Drawer } from '@lims/ui/components/Drawer';
import { Inline } from '@lims/ui/components/Inline';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { createRuleAction, listAnalytesAction, listItemPacksAction, previewRuleAction, searchItemsAction } from '../server/actions';
import { PREVIEW_FACT_KIND, RULE_KINDS, type Analyte, type Instrument, type ItemSummary, type Pack, type RuleCreate, type RuleKind, type RulePreview, type Store, type TestRef } from '../server/types';
import { Pick, ProblemBanner, qtyError, useAttemptKey, type Failure } from './shared';

export const KIND_LABEL: Record<RuleKind, string> = {
  per_test: 'Per test',
  per_analyte: 'Per analyte result',
  per_rerun: 'Per rerun',
  per_qc: 'Per QC observation',
  per_calibration: 'Per calibration',
  per_day: 'Per analyser-day',
};
/** Inline guidance (Banner info) per kind, verbatim from 04-UI-UX §3 S13. */
export const KIND_GUIDANCE: Record<RuleKind, string> = {
  per_test: 'Deducted once for each test on an order when its first result is verified.',
  per_analyte: 'Deducted once for each verified result of this analyte.',
  per_rerun: 'Deducted when the analyser reports a rerun. Not every analyser reports reruns.',
  per_qc: 'Deducted for each QC result received from the analyser. If you leave the analyte empty, this is deducted once for every analyte in every QC run.',
  per_calibration: 'Deducted when someone logs a calibration on the Bench page, or when the analyser reports a calibration (supported analysers only).',
  per_day: 'Deducted once per day for each day the analyser sent any results.',
};
export const NO_RULE_MATCHES = 'No consumption rule matches';
const BASE = '__base';
const EVERY_QC = '__all';

export interface RuleFormProps {
  tests: readonly TestRef[];
  instruments: readonly Instrument[];
  items: readonly ItemSummary[];
  stores: readonly Store[];
  /** inventory.cost.read: the estimated value column of the preview is shown only then (and only if the API sent it). */
  canCost: boolean;
  onDone: () => void;
}

const find = <T,>(list: readonly T[], q: string, text: (t: T) => string) => {
  const n = q.trim().toLowerCase();
  return list.filter((t) => text(t).toLowerCase().includes(n)).slice(0, 20);
};

export function RuleForm(p: RuleFormProps) {
  const key = useAttemptKey();
  const busy = useRef(false);
  const [kind, setKind] = useState<RuleKind>();
  const [test, setTest] = useState<TestRef>();
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [analyte, setAnalyte] = useState<string>();
  const [any, setAny] = useState(false);
  const [analyser, setAnalyser] = useState<Instrument>();
  const [item, setItem] = useState<ItemSummary>();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [unit, setUnit] = useState<string>();
  const [qty, setQty] = useState<string>();
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<RulePreview>();

  const needsAnalyte = kind === 'per_analyte' || kind === 'per_qc';

  useEffect(() => {
    setAnalytes([]);
    setAnalyte(undefined);
    if (!test) return;
    let live = true;
    void listAnalytesAction(test.id).then((r) => live && setAnalytes(r.ok ? r.data : []));
    return () => {
      live = false;
    };
  }, [test?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPacks([]);
    setUnit(undefined);
    if (!item) return;
    let live = true;
    void listItemPacksAction(item.id).then((r) => live && setPacks(r.ok ? r.data : []));
    return () => {
      live = false;
    };
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickKind = (k: RuleKind) => {
    setKind(k);
    setErrors({});
    setProblem(undefined);
    if (k === 'per_day') setAny(false);
    if (k !== 'per_analyte' && k !== 'per_qc') setAnalyte(undefined);
  };

  /** What both Save and Preview need: kind, test (not for analyser-day), analyte (per analyte result), analyser (analyser-day). */
  const scopeErrors = () => ({
    ...(kind ? {} : { kind: 'Kind is required' }),
    ...(kind && kind !== 'per_day' && !test ? { test: 'Test is required' } : {}),
    ...(kind === 'per_analyte' && !analyte ? { analyte: 'Analyte is required' } : {}),
    ...(kind === 'per_day' && !analyser ? { analyser: 'Analyser is required' } : {}),
  });
  const scope = () => ({
    ...(kind !== 'per_day' && test ? { test_id: test.id } : {}),
    ...(needsAnalyte && analyte && analyte !== EVERY_QC ? { analyte_id: analyte } : {}),
    ...(!any && analyser ? { instrument_id: analyser.id } : {}),
  });

  const save = async () => {
    if (busy.current) return;
    const e: Record<string, string> = {
      ...scopeErrors(),
      ...(item ? {} : { item: 'Item is required' }),
      ...(qtyError('Quantity', qty) ? { qty: qtyError('Quantity', qty) as string } : {}),
    };
    setErrors(e);
    if (Object.keys(e).length || !kind || !item) return;
    const pack = unit && unit !== BASE ? unit : undefined;
    const body: RuleCreate = { rule_kind: kind, item_id: item.id, qty: (qty as string).trim(), ...scope(), ...(pack ? { pack_id: pack } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) };
    busy.current = true;
    setSaving(true);
    const r = await createRuleAction(body, key.get(JSON.stringify(body)));
    busy.current = false;
    setSaving(false);
    if (!r.ok) return setProblem(r);
    key.reset();
    p.onDone();
  };

  const runPreview = async () => {
    const e = scopeErrors();
    setErrors(e);
    if (Object.keys(e).length || !kind) return;
    setPreviewing(true);
    const r = await previewRuleAction({ fact_kind: PREVIEW_FACT_KIND[kind], ...scope() });
    setPreviewing(false);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    setPreview(r.data);
  };

  const unitOptions = [{ value: BASE, label: `${item?.base_uom_code ?? 'Base unit'} (base unit)` }, ...packs.map((k) => ({ value: k.id, label: k.label }))];

  return (
    <Stack>
      <ProblemBanner problem={problem} {...(problem?.code === 'inventory.rule_conflict' ? { hint: 'A current rule already exists for this combination. Use Change quantity on that rule instead.' } : {})} />
      <RadioGroup<RuleKind> label="Kind" name="rule_kind" isRequired options={RULE_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} {...(kind ? { value: kind } : {})} {...(errors['kind'] ? { error: errors['kind'] } : {})} onChange={pickKind} />
      {kind ? <Banner tone="info" title={KIND_GUIDANCE[kind]} /> : null}
      {kind && kind !== 'per_day' ? (
        <Combobox<TestRef>
          label="Test"
          name="test_id"
          isRequired
          loadOptions={async (q) => find(p.tests, q, (t) => `${t.code} ${t.name}`)}
          getKey={(t) => t.id}
          renderOption={(t) => `${t.code} · ${t.name}`}
          renderValue={(t) => `${t.code} · ${t.name}`}
          value={test}
          onChange={setTest}
          {...(errors['test'] ? { error: errors['test'] } : {})}
        />
      ) : null}
      {needsAnalyte ? (
        <Pick
          label="Analyte"
          name="analyte_id"
          {...(kind === 'per_analyte' ? { isRequired: true } : {})}
          placeholder={kind === 'per_qc' ? 'Analyte — every QC result' : 'Analyte — choose one'}
          options={[...(kind === 'per_qc' ? [{ value: EVERY_QC, label: 'Every QC result on this analyser' }] : []), ...analytes.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))]}
          value={analyte}
          error={errors['analyte']}
          onChange={setAnalyte}
        />
      ) : null}
      {kind ? (
        <>
          <Combobox<Instrument>
            key={any ? 'any' : 'one'}
            label="Analyser"
            name="instrument_id"
            {...(kind === 'per_day' ? { isRequired: true } : {})}
            {...(any ? { isDisabled: true } : {})}
            loadOptions={async (q) => find(p.instruments, q, (i) => `${i.instrument_code} ${i.display_name}`)}
            getKey={(i) => i.id}
            renderOption={(i) => `${i.instrument_code} · ${i.display_name}`}
            renderValue={(i) => `${i.instrument_code} · ${i.display_name}`}
            {...(any ? {} : { value: analyser })}
            onChange={setAnalyser}
            {...(errors['analyser'] ? { error: errors['analyser'] } : {})}
          />
          {kind !== 'per_day' ? (
            <Checkbox
              label="Any analyser"
              isSelected={any}
              onChange={(v) => {
                setAny(v);
                if (v) setAnalyser(undefined);
              }}
            />
          ) : null}
        </>
      ) : null}
      <Combobox<ItemSummary>
        label="Item"
        name="item_id"
        isRequired
        loadOptions={async (q) => {
          const r = await searchItemsAction(q);
          return r.ok ? r.data : [];
        }}
        getKey={(i) => i.id}
        renderOption={(i) => `${i.item_code} · ${i.name}`}
        renderValue={(i) => `${i.item_code} · ${i.name}`}
        value={item}
        onChange={setItem}
        {...(errors['item'] ? { error: errors['item'] } : {})}
      />
      <Inline gap={2}>
        <DecimalField label="Quantity" name="qty" decimals={3} allowNegative isRequired {...(qty !== undefined ? { value: qty } : {})} {...(errors['qty'] ? { error: errors['qty'] } : {})} onChange={setQty} />
        <Pick label="Unit" name="pack_id" placeholder="Unit — base unit" options={unitOptions} value={unit} onChange={setUnit} />
      </Inline>
      <TextArea label="Notes" name="notes" maxLength={500} value={notes} onChange={setNotes} />
      <Inline gap={2}>
        <Button variant="primary" isLoading={saving} onPress={() => void save()}>Save</Button>
        <Button isLoading={previewing} onPress={() => void runPreview()}>Preview</Button>
      </Inline>
      {preview ? <PreviewDrawer r={preview} items={p.items} stores={p.stores} canCost={p.canCost} onClose={() => setPreview(undefined)} /> : null}
    </Stack>
  );
}

type PreviewLine = RulePreview['lines'][number];

/** Result of the dry run: what would be deducted, where. AC-12.6: the API picks the rule (instrument-specific beats generic); the screen lists exactly what it returns. */
function PreviewDrawer({ r, items, stores, canCost, onClose }: { r: RulePreview; items: readonly ItemSummary[]; stores: readonly Store[]; canCost: boolean; onClose: () => void }) {
  const storeOf = r.store_id ? stores.find((s) => s.id === r.store_id) : undefined;
  const itemLabel = (id: string) => {
    const i = items.find((x) => x.id === id);
    return i ? `${i.item_code} · ${i.name}` : 'Unknown item';
  };
  const withValue = canCost && r.lines.some((l) => l.est_value_paisa !== undefined);
  const columns: ColumnDef<PreviewLine>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: (l) => itemLabel(l.item_id) },
    // a deduction: shown with its minus sign and the item's base unit
    { id: 'qty', header: 'Deducted', align: 'end', cell: (l) => `−${l.qty_base} ${items.find((x) => x.id === l.item_id)?.base_uom_code ?? ''}`.trim() },
    { id: 'store', header: 'Store', cell: () => (storeOf ? `${storeOf.store_code} · ${storeOf.name}` : '—') },
    ...(withValue ? [{ id: 'value', header: 'Estimated value', align: 'end' as const, cell: (l: PreviewLine) => (l.est_value_paisa !== undefined ? <MoneyText value={{ amountPaisa: l.est_value_paisa, currency: 'NPR' }} /> : '—') }] : []),
  ];
  return (
    <Drawer title="Preview of deductions" isOpen onClose={onClose}>
      <Stack>
        {r.store_resolution_step === 6 && !r.store_id ? (
          <Banner tone="warning" title="No store found">
            <p>These deductions would wait in Waiting consumption until a store is linked to the analyser or a default store is set.</p>
          </Banner>
        ) : null}
        <DataTable caption="Deductions" columns={columns} rows={r.lines} getRowId={(l) => l.rule_id + l.item_id + (l.lot_id ?? '')} density="compact" emptyState={{ title: NO_RULE_MATCHES }} />
        <p>Nothing is saved by a preview.</p>
      </Stack>
    </Drawer>
  );
}
