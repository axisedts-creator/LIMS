'use client';
// S4 "Reorder settings" tab (04-UI-UX §3 S4): one row per item, each row saves on blur (or on toggle) with If-Match when the row exists.
// Quantities are DecimalString (never floats). LD-140: kit components only. Without inventory.master.manage the values are read-only text.
// [CONV] The kit grid renders cell content one render late, so a cell that reads parent state would show a stale value mid-typing.
// Every field therefore keeps its own state; the row drafts and saved versions live in refs and only the error banner re-renders the parent.
import { useRef, useState } from 'react';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { Switch } from '@lims/ui/components/Switch';
import { putStoreItemSettingAction } from '../server/actions';
import type { ItemSummary, StoreItemSetting, SupplierSummary } from '../server/types';
import { NONE } from './codes';
import { ProblemBanner, type Failure } from './shared';

interface Row { level: string | undefined; qty: string | undefined; max: string | undefined; supplier: string; stocked: boolean }
const toRow = (s?: StoreItemSetting): Row => ({
  level: s?.reorder_level_base, qty: s?.reorder_qty_base, max: s?.max_level_base, supplier: s?.preferred_supplier_id ?? NONE,
  stocked: s?.is_stocked ?? true, // [CONV] an item with no row yet is stocked until someone says otherwise
});
const same = (a: Row, b: Row) => a.level === b.level && a.qty === b.qty && a.max === b.max && a.supplier === b.supplier && a.stocked === b.stocked;
const QTY = /^[0-9]{1,12}(\.[0-9]{1,6})?$/;
const badQty = (v: string | undefined) => v !== undefined && (!QTY.test(v) || !(Number(v) > 0));
const local = (title: string): Failure => ({ ok: false, status: 400, code: 'common.validation_failed', title });

function Qty({ label, name, initial, onValue }: { label: string; name: string; initial: string | undefined; onValue: (v: string | undefined) => void }) {
  const [v, setV] = useState(initial);
  return (
    <DecimalField
      label={label}
      name={name}
      decimals={6}
      {...(v !== undefined ? { value: v } : {})}
      onChange={(x) => {
        setV(x);
        onValue(x);
      }}
    />
  );
}
function Supplier({ id, initial, options, onValue }: { id: string; initial: string; options: readonly { value: string; label: string }[]; onValue: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Select
      label="Preferred supplier"
      name={`supplier-${id}`}
      options={options}
      value={v}
      onChange={(x) => {
        setV(x);
        onValue(x);
      }}
    />
  );
}
function Stocked({ id, initial, onValue }: { id: string; initial: boolean; onValue: (v: boolean) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Switch
      label="Stocked"
      name={`stocked-${id}`}
      isSelected={v}
      onChange={(x) => {
        setV(x);
        onValue(x);
      }}
    />
  );
}

export function ReorderSettings({ storeId, items, settings, suppliers, canManage }: { storeId: string; items: readonly ItemSummary[]; settings: readonly StoreItemSetting[]; suppliers: readonly SupplierSummary[]; canManage: boolean }) {
  const saved = useRef(new Map(settings.map((s) => [s.item_id, s])));
  const draft = useRef<Record<string, Row>>(Object.fromEntries(items.map((i) => [i.id, toRow(saved.current.get(i.id))])));
  const [problem, setProblem] = useState<Failure>();
  const busy = useRef(new Set<string>());
  const again = useRef(new Set<string>());

  const save = async (itemId: string): Promise<void> => {
    const next = draft.current[itemId];
    if (!next) return;
    const prev = saved.current.get(itemId);
    if (same(toRow(prev), next)) return;
    if (badQty(next.level) || badQty(next.qty) || badQty(next.max)) return setProblem(local('Enter a quantity above zero with up to 6 decimals'));
    if (busy.current.has(itemId)) {
      again.current.add(itemId);
      return;
    }
    busy.current.add(itemId);
    try {
      // Saves fire from blur/toggle handlers (no error boundary there), so a transport failure must become a banner, not an unhandled rejection.
      const r = await putStoreItemSettingAction(storeId, itemId, prev?.version, {
        is_stocked: next.stocked,
        ...(next.level ? { reorder_level_base: next.level } : {}),
        ...(next.qty ? { reorder_qty_base: next.qty } : {}),
        ...(next.max ? { max_level_base: next.max } : {}),
        ...(next.supplier !== NONE ? { preferred_supplier_id: next.supplier } : {}),
      }).catch((): Failure => ({ ok: false, status: 503, code: 'common.service_unavailable', title: 'Could not save. Try again.' }));
      if (!r.ok) return setProblem(r);
      setProblem(undefined);
      saved.current.set(itemId, r.data);
    } finally {
      busy.current.delete(itemId);
      if (again.current.delete(itemId)) void save(itemId);
    }
  };
  const edit = (itemId: string, patch: Partial<Row>, now = false) => {
    draft.current[itemId] = { ...draft.current[itemId]!, ...patch };
    if (now) void save(itemId);
  };
  const supplierOptions = [{ value: NONE, label: 'No preferred supplier' }, ...suppliers.map((s) => ({ value: s.id, label: `${s.supplier_code} — ${s.name}` }))];
  const text = (v: string | undefined) => v ?? '—';

  const columns: ColumnDef<ItemSummary>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: (i) => <><span>{i.item_code}</span> <span>{i.name}</span></> },
    {
      id: 'level', header: 'Reorder level', align: 'end',
      cell: (i) => (canManage ? <div onBlur={() => void save(i.id)}><Qty label="Reorder level" name={`level-${i.id}`} initial={draft.current[i.id]?.level} onValue={(v) => edit(i.id, { level: v })} /></div> : text(draft.current[i.id]?.level)),
    },
    {
      id: 'qty', header: 'Reorder qty', align: 'end',
      cell: (i) => (canManage ? <div onBlur={() => void save(i.id)}><Qty label="Reorder qty" name={`qty-${i.id}`} initial={draft.current[i.id]?.qty} onValue={(v) => edit(i.id, { qty: v })} /></div> : text(draft.current[i.id]?.qty)),
    },
    {
      id: 'max', header: 'Max level', align: 'end',
      cell: (i) => (canManage ? <div onBlur={() => void save(i.id)}><Qty label="Max level" name={`max-${i.id}`} initial={draft.current[i.id]?.max} onValue={(v) => edit(i.id, { max: v })} /></div> : text(draft.current[i.id]?.max)),
    },
    {
      id: 'supplier', header: 'Preferred supplier',
      cell: (i) => {
        const cur = draft.current[i.id]?.supplier ?? NONE;
        return canManage ? <Supplier id={i.id} initial={cur} options={supplierOptions} onValue={(v) => edit(i.id, { supplier: v }, true)} /> : supplierOptions.find((o) => o.value === cur)?.label ?? '—';
      },
    },
    {
      id: 'stocked', header: 'Stocked',
      cell: (i) => (canManage ? <Stocked id={i.id} initial={draft.current[i.id]?.stocked ?? true} onValue={(v) => edit(i.id, { stocked: v }, true)} /> : draft.current[i.id]?.stocked === false ? 'No' : 'Yes'),
    },
  ];
  return (
    <Stack>
      <ProblemBanner problem={problem} />
      <DataTable caption="Reorder settings" columns={columns} rows={items} getRowId={(i) => i.id} emptyState={{ title: 'No items to set up yet.' }} />
    </Stack>
  );
}
