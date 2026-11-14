'use client';
// S3 Packs tab (04-UI-UX §3 S3). Pack size is immutable (AC-01.x): the table shows it as plain text; changes are a new pack.
// LD-140: kit components only; "Add pack" is secondary because the page's one primary action is Edit.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { CodeField } from '@lims/ui/components/CodeField';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createPackAction } from '../server/actions';
import type { CodedValue, Item, Pack } from '../server/types';
import { PACK_CODE } from './codes';
import { ActiveChip, ProblemBanner, useIdemKey, yesNo, type Failure } from './shared';

function PackForm({ item, uom, onDone }: { item: Item; uom: readonly CodedValue[]; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [packLabel, setPackLabel] = useState('');
  const [unit, setUnit] = useState<string>();
  const [qty, setQty] = useState<string>();
  const [dflt, setDflt] = useState(false);
  const [problem, setProblem] = useState<Failure>();
  const key = useIdemKey();
  const onSubmit = async () => {
    setProblem(undefined);
    const r = await createPackAction(item.id, { pack_code: code, label: packLabel.trim(), uom_code: unit ?? '', qty_in_base: qty ?? '', is_purchase_default: dflt }, key.get());
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };
  return (
    <Form onSubmit={onSubmit} {...(problem?.errors ? { problem: { errors: problem.errors } } : {})}>
      <Stack>
        <ProblemBanner problem={problem} />
        <CodeField label="Code" name="pack_code" maxLength={16} pattern={PACK_CODE} patternHint="Letters A–Z, digits and _ (up to 16)" isRequired value={code} onChange={setCode} />
        <TextField label="Label" name="label" maxLength={60} isRequired value={packLabel} onChange={setPackLabel} />
        <Select label="Unit" name="uom_code" isRequired options={uom.map((u) => ({ value: u.code, label: u.display }))} {...(unit ? { value: unit } : {})} onChange={setUnit} />
        <DecimalField label="Qty in base" name="qty_in_base" decimals={6} min="0.000001" max="999999999999" isRequired suffix={item.base_uom_code} {...(qty !== undefined ? { value: qty } : {})} onChange={setQty} />
        <Checkbox label="Purchase default" name="is_purchase_default" isSelected={dflt} onChange={setDflt} />
        <Button type="submit" variant="primary">
          Save
        </Button>
      </Stack>
    </Form>
  );
}

export function ItemPacks({ item, canManage, uom }: { item: Item; canManage: boolean; uom: readonly CodedValue[] }) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const columns: ColumnDef<Pack>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (p) => p.pack_code },
    { id: 'label', header: 'Label', cell: (p) => p.label },
    { id: 'unit', header: 'Unit', cell: (p) => p.uom_code },
    { id: 'qty', header: 'Qty in base', align: 'end', cell: (p) => p.qty_in_base },
    { id: 'default', header: 'Default', cell: (p) => yesNo(p.is_purchase_default) },
    { id: 'active', header: 'Active', cell: (p) => <ActiveChip active={p.is_active} /> },
  ];
  return (
    <Stack>
      <Inline justify="between">
        <p className="lims-description">Pack size cannot change. Add a new pack instead.</p>
        {canManage ? <Button onPress={() => setAdding(true)}>Add pack</Button> : null}
      </Inline>
      <DataTable caption="Packs" columns={columns} rows={item.packs} getRowId={(p) => p.id} emptyState={{ title: 'No packs yet.' }} />
      <Drawer title="Add pack" isOpen={adding} onClose={() => setAdding(false)}>
        {adding ? (
          <PackForm
            item={item}
            uom={uom}
            onDone={() => {
              setAdding(false);
              toast.show({ tone: 'success', title: 'Pack added' });
              router.refresh();
            }}
          />
        ) : null}
      </Drawer>
    </Stack>
  );
}
