'use client';
// S13 Consumption rules (04-UI-UX §3 S13; AC-12.1/.6/.7/.9, AC-14.2). Help: inventory.help.consumption_model.
// LD-140 (2026-11-13): list + right Drawer; "New rule" is the ONE primary button on the page; status = tone + icon + word.
// Gating: the page needs inventory.item.read; New rule / Change quantity / Deactivate need inventory.master.manage (the API enforces it too).
import { useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { useToast } from '@lims/ui/components/Toast';
import { deactivateRuleAction, searchItemsAction, supersedeRuleAction } from '../server/actions';
import { RULE_KINDS, type Analyte, type Instrument, type ItemSummary, type Rule, type RuleKind, type Store, type TestRef } from '../server/types';
import { KIND_LABEL, RuleForm } from './RuleForm';
import { Chip, isoDate, newKey, Pick, ProblemBanner, qtyError, useAttemptKey, type Failure } from './shared';

const ALL = '__all';
export const CONSUMPTION_HELP = '/help/inventory.help.consumption_model';

export interface RulesViewProps {
  rules: readonly Rule[];
  tests: readonly TestRef[];
  analytes: readonly Analyte[];
  instruments: readonly Instrument[];
  items: readonly ItemSummary[];
  stores: readonly Store[];
  filters: { kind?: string | undefined; test?: string | undefined; analyser?: string | undefined; item?: string | undefined; history: boolean };
  canManage: boolean;
  canCost: boolean;
}

/** Current = active and not ended; Superseded = ended by a newer rule; Inactive = switched off. */
export function ruleStatus(r: Rule, now = Date.now()): { tone: 'success' | 'neutral' | 'warning'; label: 'Current' | 'Superseded' | 'Inactive' } {
  if (!r.is_active) return { tone: 'neutral', label: 'Inactive' };
  if (r.effective_to && Date.parse(r.effective_to) <= now) return { tone: 'warning', label: 'Superseded' };
  return { tone: 'success', label: 'Current' };
}

export function RulesView(p: RulesViewProps) {
  const router = useRouter();
  const path = usePathname();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [changing, setChanging] = useState<Rule>();
  const [deactivating, setDeactivating] = useState<Rule>();
  const [problem, setProblem] = useState<Failure>();

  const testOf = (id?: string) => p.tests.find((t) => t.id === id);
  const itemOf = (id: string) => p.items.find((i) => i.id === id);
  const go = (next: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ kind: p.filters.kind, test: p.filters.test, analyser: p.filters.analyser, item: p.filters.item, history: p.filters.history ? '1' : undefined, ...next })) if (v) q.set(k, v);
    const s = q.toString();
    router.replace(s ? `${path}?${s}` : path);
  };
  const pickFilter = (k: string) => (v: string) => go({ [k]: v === ALL ? undefined : v });

  const columns: ColumnDef<Rule>[] = [
    { id: 'kind', header: 'Kind', isRowHeader: true, cell: (r) => KIND_LABEL[r.rule_kind] ?? r.rule_kind },
    { id: 'test', header: 'Test', cell: (r) => { const t = testOf(r.test_id); return t ? `${t.code} · ${t.name}` : '—'; } },
    { id: 'analyte', header: 'Analyte', cell: (r) => { const a = p.analytes.find((x) => x.id === r.analyte_id); return a ? `${a.code} · ${a.name}` : '—'; } },
    { id: 'analyser', header: 'Analyser', cell: (r) => { const i = p.instruments.find((x) => x.id === r.instrument_id); return r.instrument_id ? (i ? i.instrument_code : '—') : 'Any analyser'; } },
    { id: 'item', header: 'Item', cell: (r) => { const i = itemOf(r.item_id); return i ? `${i.item_code} · ${i.name}${i.is_active ? '' : ' (inactive item)'}` : '—'; } },
    { id: 'qty', header: 'Quantity', align: 'end', cell: (r) => `${r.qty_base} ${itemOf(r.item_id)?.base_uom_code ?? ''}`.trim() },
    { id: 'from', header: 'Effective from', cell: (r) => isoDate(r.effective_from) },
    { id: 'status', header: 'Status', cell: (r) => { const s = ruleStatus(r); return <Chip tone={s.tone} label={s.label} />; } },
    ...(p.canManage
      ? [{
          id: 'actions',
          header: 'Actions',
          cell: (r: Rule) =>
            ruleStatus(r).label === 'Current' ? (
              <Inline gap={1}>
                <Button size="sm" onPress={() => setChanging(r)}>Change quantity</Button>
                <Button size="sm" variant="ghost" onPress={() => setDeactivating(r)}>Deactivate</Button>
              </Inline>
            ) : null,
        }]
      : []),
  ];

  const deactivate = async (r: Rule) => {
    const res = await deactivateRuleAction(r.id, r.version, newKey());
    setDeactivating(undefined);
    if (!res.ok) return setProblem(res);
    setProblem(undefined);
    toast.show({ tone: 'success', title: 'Rule deactivated' });
    router.refresh();
  };

  return (
    <section aria-label="Consumption rules">
      <PageHeader title="Consumption rules" helpKey="inventory.help.consumption_model" {...(p.canManage ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New rule</Button> } : {})} />
      <Stack>
        <a className="lims-link" href={CONSUMPTION_HELP}>Help: how automatic deduction works</a>
        <ProblemBanner problem={problem} />
        {/* T0D-UILIST-3 (LD-353 template 1): the filters are the page's one FilterBar row (kit .lims-filter-bar). */}
        <div role="search" className="lims-filter-bar">
          <Pick label="Kind filter" name="kind" options={[{ value: ALL, label: 'All kinds' }, ...RULE_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))]} value={p.filters.kind ?? ALL} onChange={pickFilter('kind')} />
          <Pick label="Test filter" name="test" options={[{ value: ALL, label: 'All tests' }, ...p.tests.map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }))]} value={p.filters.test ?? ALL} onChange={pickFilter('test')} />
          <Pick label="Analyser filter" name="analyser" options={[{ value: ALL, label: 'All analysers' }, ...p.instruments.map((i) => ({ value: i.id, label: `${i.instrument_code} · ${i.display_name}` }))]} value={p.filters.analyser ?? ALL} onChange={pickFilter('analyser')} />
          {/* Item filter (04-UI-UX S13 "Filters: kind, test, analyser, item, show history"); clearing the text = all items. */}
          <Combobox<ItemSummary>
            label="Item filter"
            name="item"
            loadOptions={async (q) => {
              const r = await searchItemsAction(q);
              return r.ok ? r.data : [];
            }}
            getKey={(i) => i.id}
            renderOption={(i) => `${i.item_code} · ${i.name}`}
            renderValue={(i) => `${i.item_code} · ${i.name}`}
            value={p.filters.item ? itemOf(p.filters.item) : undefined}
            onChange={(v) => go({ item: v?.id })}
          />
          <Checkbox label="Show history" isSelected={p.filters.history} onChange={(v) => go({ history: v ? '1' : undefined })} />
        </div>
        <DataTable caption="Consumption rules" columns={columns} rows={p.rules} getRowId={(r) => r.id} cellTitle emptyState={{ title: 'No consumption rules. Automatic deduction does nothing until you add rules.' }} />
      </Stack>
      <Drawer title="New consumption rule" isOpen={creating} onClose={() => setCreating(false)}>
        {creating ? (
          <RuleForm
            tests={p.tests}
            instruments={p.instruments}
            items={p.items}
            stores={p.stores}
            canCost={p.canCost}
            onDone={() => {
              setCreating(false);
              toast.show({ tone: 'success', title: 'Rule saved' });
              router.refresh();
            }}
          />
        ) : null}
      </Drawer>
      {changing ? (
        <ChangeQuantity
          rule={changing}
          uom={itemOf(changing.item_id)?.base_uom_code}
          onClose={() => setChanging(undefined)}
          onDone={() => {
            setChanging(undefined);
            toast.show({ tone: 'success', title: 'Quantity changed. The old rule stopped.' });
            router.refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        title="Deactivate rule"
        body="Deactivate this rule? Automatic deduction stops using it now. Earlier deductions are not changed."
        confirmLabel="Deactivate"
        tone="danger"
        isOpen={!!deactivating}
        onCancel={() => setDeactivating(undefined)}
        onConfirm={() => (deactivating ? deactivate(deactivating) : undefined)}
      />
    </section>
  );
}

/** "Change quantity" = supersede (TRD #72): the old rule ends now, a new one starts now. */
function ChangeQuantity({ rule, uom, onClose, onDone }: { rule: Rule; uom: string | undefined; onClose: () => void; onDone: () => void }) {
  const key = useAttemptKey();
  const busy = useRef(false);
  const [qty, setQty] = useState<string | undefined>(rule.qty_base);
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (busy.current) return;
    const e = qtyError('Quantity', qty);
    setError(e);
    if (e) return;
    const body = { qty: (qty as string).trim() };
    busy.current = true;
    setSaving(true);
    const r = await supersedeRuleAction(rule.id, rule.version, key.get(JSON.stringify(body)), body);
    busy.current = false;
    setSaving(false);
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };
  return (
    <Dialog
      title="Change quantity"
      isOpen
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Close</Button>
          <Button variant="primary" isLoading={saving} onPress={() => void submit()}>Save</Button>
        </>
      }
    >
      <Stack>
        <ProblemBanner problem={problem} />
        <p>The old rule stops now. Earlier deductions are not changed.</p>
        <DecimalField label="Quantity" name="qty" decimals={3} allowNegative isRequired {...(qty !== undefined ? { value: qty } : {})} {...(error ? { error } : {})} {...(uom ? { suffix: uom } : {})} onChange={setQty} />
      </Stack>
    </Dialog>
  );
}
