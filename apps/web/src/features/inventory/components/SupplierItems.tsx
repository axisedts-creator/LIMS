'use client';
// S5 supplier Items tab (04-UI-UX §3 S5; AC-04.2): item + pack + supplier code + last price + lead time + default tax.
// The price is money and exists only with inventory.cost.read: the server page strips it otherwise, and this file renders no price
// column or field without `canCost` (REQ-SEC-081). Price is entered in rupees and sent as integer paisa. LD-140: kit components only.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { listItemPacksAction, putSupplierItemAction, searchItemsAction } from '../server/actions';
import type { CodedValue, ItemSummary, Pack, SupplierItem, SupplierItemPut } from '../server/types';
import { intText, NONE } from './codes';
import { ActiveChip, ProblemBanner, type Failure } from './shared';

export interface ItemInfo { id: string; item_code: string; name: string; packs: readonly Pack[] }

function SupplierItemForm({ supplierId, existing, info, canCost, tax, onDone }: { supplierId: string; existing?: SupplierItem; info?: ItemInfo; canCost: boolean; tax: readonly CodedValue[]; onDone: () => void }) {
  const [item, setItem] = useState<ItemSummary>();
  const [packs, setPacks] = useState<readonly Pack[]>(info?.packs ?? []);
  const [packId, setPackId] = useState<string | undefined>(existing?.pack_id);
  const [code, setCode] = useState(existing?.supplier_item_code ?? '');
  const [price, setPrice] = useState<Money | undefined>(existing?.last_unit_price_paisa === undefined ? undefined : { amountPaisa: existing.last_unit_price_paisa, currency: 'NPR' });
  const [lead, setLead] = useState(existing?.lead_time_days === undefined ? '' : String(existing.lead_time_days));
  const [taxCode, setTaxCode] = useState(existing?.default_tax_code ?? NONE);
  const [own, setOwn] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Failure>();

  const pickItem = async (i: ItemSummary | undefined) => {
    setItem(i);
    setPackId(undefined);
    setPacks([]);
    if (!i) return;
    const r = await listItemPacksAction(i.id);
    if (r.ok) setPacks(r.data);
  };
  const onSubmit = async () => {
    const itemId = existing?.item_id ?? item?.id;
    const pId = existing?.pack_id ?? packId;
    const e: Record<string, string> = {};
    const l = intText('Lead time', lead, 0, 365);
    if (l) e['lead_time_days'] = l;
    setOwn(e);
    if (Object.keys(e).length || !itemId || !pId) return;
    setProblem(undefined);
    const body: SupplierItemPut = {
      is_active: existing?.is_active ?? true,
      ...(code.trim() ? { supplier_item_code: code.trim() } : {}),
      ...(canCost && price ? { last_unit_price_paisa: price.amountPaisa } : {}),
      ...(lead.trim() ? { lead_time_days: Number(lead) } : {}),
      ...(taxCode !== NONE ? { default_tax_code: taxCode } : {}),
    };
    const r = await putSupplierItemAction(supplierId, itemId, pId, existing?.version, body);
    if (!r.ok) return setProblem(r);
    onDone();
  };

  return (
    <Form onSubmit={onSubmit} {...(problem?.errors ? { problem: { errors: problem.errors } } : {})}>
      <Stack>
        <ProblemBanner problem={problem} />
        {existing ? (
          <>
            <TextField label="Item" name="item_label" maxLength={260} isReadOnly value={info ? `${info.item_code} — ${info.name}` : existing.item_id} />
            <TextField label="Pack" name="pack_label" maxLength={80} isReadOnly value={packs.find((p) => p.id === existing.pack_id)?.pack_code ?? existing.pack_id} />
          </>
        ) : (
          <>
            <Combobox<ItemSummary>
              label="Item"
              name="item_id"
              isRequired
              loadOptions={async (q) => {
                const r = await searchItemsAction(q);
                return r.ok ? r.data : [];
              }}
              getKey={(i) => i.id}
              renderOption={(i) => `${i.item_code} — ${i.name}`}
              renderValue={(i) => `${i.item_code} — ${i.name}`}
              value={item}
              onChange={(i) => void pickItem(i)}
            />
            <Select label="Pack" name="pack_id" isRequired options={packs.map((p) => ({ value: p.id, label: `${p.pack_code} — ${p.label}` }))} {...(packId ? { value: packId } : {})} onChange={setPackId} />
          </>
        )}
        <TextField label="Supplier code" name="supplier_item_code" maxLength={64} value={code} onChange={setCode} />
        {canCost ? <MoneyField label="Last price" name="last_unit_price_paisa" {...(price ? { value: price } : {})} onChange={setPrice} /> : null}
        <TextField label="Lead time (days)" name="lead_time_days" maxLength={3} inputMode="numeric" value={lead} onChange={setLead} {...(own['lead_time_days'] ? { error: own['lead_time_days'] } : {})} />
        <Select label="Default tax code" name="default_tax_code" options={[{ value: NONE, label: 'Not set' }, ...tax.map((t) => ({ value: t.code, label: t.display }))]} value={taxCode} onChange={setTaxCode} />
        <Button type="submit" variant="primary">
          Save
        </Button>
      </Stack>
    </Form>
  );
}

export function SupplierItems({ supplierId, rows, info, canManage, canCost, tax }: { supplierId: string; rows: readonly SupplierItem[]; info: Readonly<Record<string, ItemInfo>>; canManage: boolean; canCost: boolean; tax: readonly CodedValue[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editor, setEditor] = useState<{ row?: SupplierItem } | undefined>();
  const itemText = (r: SupplierItem) => (info[r.item_id] ? `${info[r.item_id]!.item_code} — ${info[r.item_id]!.name}` : r.item_id);
  const packText = (r: SupplierItem) => info[r.item_id]?.packs.find((p) => p.id === r.pack_id)?.pack_code ?? r.pack_id;
  const columns: ColumnDef<SupplierItem>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: itemText },
    { id: 'pack', header: 'Pack', cell: packText },
    { id: 'code', header: 'Supplier code', cell: (r) => r.supplier_item_code ?? '—' },
    ...(canCost ? [{ id: 'price', header: 'Last price', align: 'end' as const, cell: (r: SupplierItem) => (r.last_unit_price_paisa === undefined ? '—' : <MoneyText value={{ amountPaisa: r.last_unit_price_paisa, currency: 'NPR' }} />) }] : []),
    { id: 'lead', header: 'Lead time', align: 'end', cell: (r) => (r.lead_time_days === undefined ? '—' : `${r.lead_time_days} days`) },
    { id: 'active', header: 'Active', cell: (r) => <ActiveChip active={r.is_active} /> },
    // PUT #22 is a full replacement (omitted price -> null); without inventory.cost.read the price can't be preserved, so no Edit on existing rows.
    ...(canManage && canCost ? [{ id: 'actions', header: 'Actions', cell: (r: SupplierItem) => <Button size="sm" variant="ghost" onPress={() => setEditor({ row: r })}>Edit</Button> }] : []),
  ];
  return (
    <Stack>
      {canManage ? (
        <Inline justify="end">
          <Button onPress={() => setEditor({})}>Add item</Button>
        </Inline>
      ) : null}
      <DataTable caption="Supplier items" columns={columns} rows={rows} getRowId={(r) => r.id} emptyState={{ title: 'No items linked to this supplier yet.' }} />
      <Dialog title={editor?.row ? 'Edit supplier item' : 'Add supplier item'} isOpen={!!editor} onClose={() => setEditor(undefined)}>
        {editor ? (
          <SupplierItemForm
            supplierId={supplierId}
            {...(editor.row ? { existing: editor.row } : {})}
            {...(editor.row && info[editor.row.item_id] ? { info: info[editor.row.item_id]! } : {})}
            canCost={canCost}
            tax={tax}
            onDone={() => {
              setEditor(undefined);
              toast.show({ tone: 'success', title: 'Supplier item saved' });
              router.refresh();
            }}
          />
        ) : null}
      </Dialog>
    </Stack>
  );
}
