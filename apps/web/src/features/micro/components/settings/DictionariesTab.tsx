'use client';
// 04-UI-UX §5 "Dictionaries" (AC-14.1, AC-14.3). One list per coded set (global + tenant, inactive included); master = list + right Drawer with Save.
// A global code is "edited" by writing a tenant row (PUT …/codes/{code}), so deactivating a global code writes is_active=false. AST categories are read-only.
import { useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { listCodedSetAction, upsertCodeAction } from '../../server/actions';
import { MICRO_CODE_RE, type CodedSetName, type MicroCodeDto, type MicroCodeInput } from '../../server/types';
import { Chip, FailNotice, yesNo, type Fail } from '../common';
import { useLoad } from './useLoad';

const SETS: readonly { value: CodedSetName; label: string }[] = [
  { value: 'organisms', label: 'Organisms' }, { value: 'organism_groups', label: 'Organism groups' }, { value: 'antibiotics', label: 'Antibiotics' }, { value: 'media', label: 'Media' },
  { value: 'specimen_sites', label: 'Specimen sites' }, { value: 'growth_codes', label: 'Growth codes' }, { value: 'culture_outcomes', label: 'Culture outcomes' },
  { value: 'isolate_withdraw_reasons', label: 'Isolate withdraw reasons' }, { value: 'culture_cancel_reasons', label: 'Culture cancel reasons' },
  { value: 'record_ignore_reasons', label: 'Instrument ignore reasons' }, { value: 'ast_interpretations', label: 'AST categories' },
];
const GRAM = ['gram_positive', 'gram_negative', 'yeast', 'mould', 'other'] as const;
const GRAM_LABEL: Record<string, string> = { gram_positive: 'Gram positive', gram_negative: 'Gram negative', yeast: 'Yeast', mould: 'Mould', other: 'Other' };
const SNOMED_HELP = 'Optional. Fill only if your laboratory is licensed to use SNOMED CT.';
const AST_NOTE = 'Interpretive categories are fixed per standard (CLSI, EUCAST, ECOFF) and cannot be edited here.';

const extraColumns = (set: CodedSetName): ColumnDef<MicroCodeDto>[] => {
  if (set === 'organisms') return [
    { id: 'group', header: 'Group', cell: (c) => c.organism_group_code ?? '—' }, { id: 'gram', header: 'Gram class', cell: (c) => (c.gram_class ? (GRAM_LABEL[c.gram_class] ?? c.gram_class) : '—') },
    { id: 'alert', header: 'Alert organism', cell: (c) => yesNo(c.is_alert) }, { id: 'snomed', header: 'SNOMED CT id', cell: (c) => c.snomed_ct_concept_id ?? '—' },
  ];
  if (set === 'antibiotics') return [{ id: 'class', header: 'Class', cell: (c) => c.antibiotic_class ?? '—' }];
  if (set === 'growth_codes') return [{ id: 'growth', header: 'Means growth', cell: (c) => yesNo(c.indicates_growth) }];
  if (set === 'culture_outcomes') return [{ id: 'flag', header: 'Flag', cell: (c) => c.result_flag ?? '—' }, { id: 'iso', header: 'Needs isolate', cell: (c) => yesNo(c.requires_isolate) }];
  if (set === 'ast_interpretations') return [{ id: 'std', header: 'Standard', cell: (c) => c.standard ?? '—' }];
  return [];
};

export function DictionariesTab({ canManage }: { canManage: boolean }) {
  const [set, setSet] = useState<CodedSetName>('organisms');
  const [editing, setEditing] = useState<MicroCodeDto | 'new'>();
  const { rows, loaded, fail, reload } = useLoad(() => listCodedSetAction(set), set);
  const fixed = set === 'ast_interpretations';
  const canEdit = canManage && !fixed;

  const columns: ColumnDef<MicroCodeDto>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (c) => c.code },
    { id: 'display', header: 'Display', cell: (c) => c.display },
    { id: 'source', header: 'Source', cell: (c) => (c.source === 'tenant' ? 'Tenant' : 'Global') },
    { id: 'active', header: 'Active', cell: (c) => <Chip tone={c.is_active ? 'success' : 'neutral'} label={c.is_active ? 'Active' : 'Inactive'} /> },
    { id: 'order', header: 'Order', align: 'end', cell: (c) => String(c.sort_order) },
    ...extraColumns(set),
    ...(canEdit ? [{ id: 'edit', header: 'Actions', cell: (c: MicroCodeDto) => <Button size="sm" variant="ghost" onPress={() => setEditing(c)}>Edit<VisuallyHidden> {c.code}</VisuallyHidden></Button> }] : []),
  ];

  return (
    <section aria-labelledby="micro-dict">
      <h2 id="micro-dict">Dictionaries</h2>
      <Select<CodedSetName> label="Dictionary" name="set" value={set} onChange={setSet} options={SETS} />
      {fixed ? <Banner tone="info" title={AST_NOTE} /> : null}
      <FailNotice fail={fail} />
      {canEdit ? <div><Button onPress={() => setEditing('new')}>Add code</Button></div> : null}
      <DataTable<MicroCodeDto> caption="Codes" columns={columns} rows={rows} getRowId={(c) => c.code} isLoading={!loaded} emptyState={{ title: 'No codes.' }} />
      {editing ? <CodeDrawer key={editing === 'new' ? 'new' : editing.code} set={set} code={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={reload} /> : null}
    </section>
  );
}

function CodeDrawer({ set, code, onClose, onSaved }: { set: CodedSetName; code: MicroCodeDto | undefined; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [codeValue, setCodeValue] = useState(code?.code ?? '');
  const [display, setDisplay] = useState(code?.display ?? '');
  const [order, setOrder] = useState<number | undefined>(code?.sort_order ?? 0);
  const [active, setActive] = useState(code?.is_active ?? true);
  const [group, setGroup] = useState(code?.organism_group_code ?? '');
  const [gram, setGram] = useState<string | undefined>(code?.gram_class);
  const [alert, setAlert] = useState(code?.is_alert ?? false);
  const [snomed, setSnomed] = useState(code?.snomed_ct_concept_id ?? '');
  const [klass, setKlass] = useState(code?.antibiotic_class ?? '');
  const [growth, setGrowth] = useState(code?.indicates_growth ?? false);
  const [flag, setFlag] = useState<'N' | 'A' | undefined>(code?.result_flag);
  const [needsIsolate, setNeedsIsolate] = useState(code?.requires_isolate ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fail, setFail] = useState<Fail>();

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!code && !MICRO_CODE_RE.test(codeValue)) e['code'] = 'Use 2 to 64 lowercase letters, digits or _.';
    if (set === 'organisms' && group && !MICRO_CODE_RE.test(group)) e['group'] = 'Use 2 to 64 lowercase letters, digits or _.';
    if (set === 'organisms' && snomed && !/^[0-9]{6,18}$/.test(snomed)) e['snomed'] = 'Enter 6 to 18 digits.';
    setErrors(e);
    if (Object.keys(e).length > 0 || order === undefined) return;
    setFail(undefined);
    const input: MicroCodeInput = {
      display, sort_order: order, is_active: active,
      ...(set === 'organisms' ? { is_alert: alert, ...(group ? { organism_group_code: group } : {}), ...(gram ? { gram_class: gram } : {}), ...(snomed ? { snomed_ct_concept_id: snomed } : {}) } : {}),
      ...(set === 'antibiotics' && klass ? { antibiotic_class: klass } : {}),
      ...(set === 'growth_codes' ? { indicates_growth: growth } : {}),
      ...(set === 'culture_outcomes' ? { requires_isolate: needsIsolate, ...(flag ? { result_flag: flag } : {}) } : {}),
    };
    const r = await upsertCodeAction(set, codeValue, input);
    if (r.ok) {
      toast.show({ tone: 'success', title: 'Code saved' });
      onSaved();
      onClose();
    } else setFail(r);
  };

  return (
    <Drawer title={code ? 'Edit code' : 'Add code'} isOpen onClose={onClose}>
      <FailNotice fail={fail} />
      <Form onSubmit={submit}>
        <TextField label="Code" name="code" isRequired maxLength={64} isReadOnly={!!code} value={codeValue} {...(errors['code'] ? { error: errors['code'] } : {})} onChange={setCodeValue} />
        <TextField label="Display" name="display" isRequired maxLength={200} value={display} onChange={setDisplay} />
        <IntegerField label="Order" name="sort_order" min={0} max={9999} isRequired {...(order !== undefined ? { value: order } : {})} onChange={setOrder} />
        <Switch label="Active" isSelected={active} onChange={setActive} />
        {set === 'organisms' ? (
          <>
            <TextField label="Organism group code" name="organism_group_code" maxLength={64} value={group} {...(errors['group'] ? { error: errors['group'] } : {})} onChange={setGroup} />
            <Select<string> label="Gram class" name="gram_class" {...(gram ? { value: gram } : {})} placeholder="Not set" onChange={setGram} options={GRAM.map((g) => ({ value: g, label: GRAM_LABEL[g] ?? g }))} />
            <Checkbox label="Alert organism" isSelected={alert} onChange={setAlert} />
            <TextField label="SNOMED CT concept id" name="snomed_ct_concept_id" maxLength={18} description={SNOMED_HELP} value={snomed} {...(errors['snomed'] ? { error: errors['snomed'] } : {})} onChange={setSnomed} />
          </>
        ) : null}
        {set === 'antibiotics' ? <TextField label="Antibiotic class" name="antibiotic_class" maxLength={64} value={klass} onChange={setKlass} /> : null}
        {set === 'growth_codes' ? <Checkbox label="Means growth" isSelected={growth} onChange={setGrowth} /> : null}
        {set === 'culture_outcomes' ? (
          <>
            <Select<'N' | 'A'> label="Result flag" name="result_flag" {...(flag ? { value: flag } : {})} placeholder="Not set" onChange={setFlag} options={[{ value: 'N', label: 'N: normal' }, { value: 'A', label: 'A: abnormal' }]} />
            <Checkbox label="Needs isolate" isSelected={needsIsolate} onChange={setNeedsIsolate} />
          </>
        ) : null}
        <Button type="submit" variant="primary">Save</Button>
      </Form>
    </Drawer>
  );
}
