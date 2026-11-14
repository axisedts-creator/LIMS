'use client';
// 04-UI-UX §2.11 coded-sets tab (#53 read, #54 write): corrective actions and exclusion reasons. LD-140: @lims/ui only; Active is a chip with its word, Source is text.
// Edit needs quality.config.manage (the API decides; the buttons are only hidden). The code itself is never editable.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { FormDialog, err, useSetupAction } from '../forms/fields';
import type { QualityCode } from '../types';
import { saveCodeAction } from './actions';
import { CODED_SETS, type CodedSetName } from './validate';

export function CodedSetsView({ sets, canManage }: { sets: Record<CodedSetName, QualityCode[]>; canManage: boolean }) {
  const [edit, setEdit] = useState<{ set: CodedSetName; row: QualityCode }>();
  const columns = (set: CodedSetName): ColumnDef<QualityCode>[] => [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (c) => c.code },
    { id: 'display', header: 'Display', cell: (c) => c.display },
    { id: 'order', header: 'Order', align: 'end', cell: (c) => ` ${c.sort_order} ` },
    { id: 'active', header: 'Active', cell: (c) => <StatusChip kind="generic" status={c.is_active ? 'active' : 'inactive'} label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'success' : 'neutral'} /> },
    { id: 'source', header: 'Source', cell: (c) => (c.source === 'global' ? 'Global' : c.source === 'tenant' ? 'Tenant' : c.source) },
    ...(canManage ? [{ id: 'actions', header: 'Actions', cell: (c: QualityCode) => <Button size="sm" variant="ghost" onPress={() => setEdit({ set, row: c })}>Edit</Button> }] : []),
  ];
  return (
    <>
      {CODED_SETS.map((s) => (
        <Card key={s.id} title={s.title}>
          <DataTable<QualityCode> columns={columns(s.id)} rows={sets[s.id]} getRowId={(c) => c.code} density="compact" caption={s.title} emptyState={{ title: 'No codes yet.' }} />
        </Card>
      ))}
      {edit ? <EditCodeDialog key={`${edit.set}/${edit.row.code}`} set={edit.set} row={edit.row} onClose={() => setEdit(undefined)} /> : null}
    </>
  );
}

function EditCodeDialog({ set, row, onClose }: { set: CodedSetName; row: QualityCode; onClose: () => void }) {
  const act = useSetupAction();
  const [display, setDisplay] = useState(row.display);
  const [order, setOrder] = useState<number | undefined>(row.sort_order);
  const [active, setActive] = useState(row.is_active);
  const submit = async () => {
    const input = { display: display.trim(), sort_order: order ?? Number.NaN, is_active: active };
    await act.run(JSON.stringify([set, row.code, input]), () => saveCodeAction(set, row.code, input), { ok: 'Code saved', onOk: onClose });
  };
  return (
    <FormDialog title="Edit coded value" size="sm" submitLabel="Save" onClose={onClose} onSubmit={submit} general={act.general}>
      <TextField label="Code" name="code" maxLength={100} value={row.code} isReadOnly />
      <TextField label="Display" name="display" isRequired maxLength={120} value={display} onChange={setDisplay} {...err(act.errors['display'])} />
      <IntegerField label="Order" name="sort_order" isRequired min={0} max={999} {...(order !== undefined ? { value: order } : {})} onChange={setOrder} />
      <Switch label="Active" isSelected={active} onChange={setActive} />
    </FormDialog>
  );
}
