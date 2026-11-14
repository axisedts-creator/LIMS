'use client';
// SCR-03 Specimen types & containers (04-UI-UX §4, SCR-02 pattern), two tabs. Report label defaults to Name upper-cased (AC-01.5).
import { useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import './catalog.css';
import { createMasterAction, updateMasterAction } from '../server/actions';
import { CODE_RE, type Container, type SpecimenType } from '../server/types';
import { CODE_HINT, DUPLICATE, EditorDialog, MasterTable, canManage, changed, statusText, useListFilter, useListShortcuts, type Col } from './master-ui';

/** LD-140 / 10-DESIGN-SYSTEM §6: cap colour as a swatch (decorative, class-styled) plus its name; never colour-only. No colour → dash, no swatch. */
const SWATCH: Record<string, string> = { red: 'red', green: 'green', blue: 'blue', grey: 'grey', gray: 'grey', black: 'black' };
function CapColour({ name }: { name: string | undefined }) {
  if (!name) return <>—</>;
  const tone = SWATCH[name.trim().toLowerCase()];
  return (
    <span className="catalog-colour-cell">
      <span className={`catalog-swatch${tone ? ` catalog-swatch-${tone}` : ''}`} aria-hidden="true" />
      {name}
    </span>
  );
}

const status = (r: { is_active: boolean }) => <Badge tone={r.is_active ? 'success' : 'neutral'}>{statusText(r.is_active)}</Badge>;

export function SpecimensScreen({ specimenTypes, containers, permissions }: { specimenTypes: readonly SpecimenType[]; containers: readonly Container[]; permissions: readonly string[] }) {
  const [tab, setTab] = useState('specimen_types');
  return (
    <section aria-label="Specimens & containers">
      <PageHeader title="Specimens & containers" helpKey="catalog.specimens" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Specimens & containers' }]} />
      <Tabs aria-label="Specimens & containers" items={[{ id: 'specimen_types', label: 'Specimen types' }, { id: 'containers', label: 'Containers' }]} selectedId={tab} onChange={setTab}>
        {tab === 'specimen_types' ? <SpecimenTypesTab rows={specimenTypes} permissions={permissions} /> : <ContainersTab rows={containers} specimenTypes={specimenTypes} permissions={permissions} />}
      </Tabs>
    </section>
  );
}

function SpecimenTypesTab({ rows, permissions }: { rows: readonly SpecimenType[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const [editing, setEditing] = useState<SpecimenType | 'new' | null>(null);
  const { shown, toolbar, search } = useListFilter(rows, (r) => r.name);
  const openNew = manage ? () => setEditing('new') : undefined;
  useListShortcuts(search, openNew);
  const cols: Col<SpecimenType>[] = [
    { header: 'Code', cell: (r) => r.code },
    { header: 'Name', cell: (r) => r.name },
    { header: 'Report label', cell: (r) => r.report_label },
    { header: 'Status', cell: status },
  ];
  return (
    <>
      {openNew ? <Button variant="primary" onPress={openNew}>New specimen type</Button> : null}
      {toolbar}
      <MasterTable caption="Specimen types" cols={cols} rows={shown} empty="No specimen types yet." emptyAction={openNew ? { label: 'New specimen type', onPress: openNew } : undefined} onEdit={manage ? setEditing : undefined} />
      {editing ? <SpecimenTypeDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function SpecimenTypeDialog({ item, onClose }: { item: SpecimenType | undefined; onClose: () => void }) {
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [label, setLabel] = useState(item?.report_label ?? '');
  const [labelTouched, setLabelTouched] = useState(!!item);
  const [active, setActive] = useState(item?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  const body = { name, report_label: label, is_active: active };
  return (
    <EditorDialog
      title={item ? 'Edit specimen type' : 'New specimen type'}
      savedText="Specimen type saved."
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      save={(key) => (item ? updateMasterAction('specimen_type', item.id, item.version, changed(item, body)) : createMasterAction('specimen_type', { code, ...body }, key))}
    >
      <CodeField label="Code" name="code" maxLength={32} pattern={CODE_RE.source} patternHint={CODE_HINT} isRequired isReadOnly={!!item} value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Name" name="name" maxLength={100} isRequired value={name} onChange={(v) => { setName(v); if (!labelTouched) setLabel(v.toUpperCase().slice(0, 100)); }} />
      <TextField label="Report label" name="report_label" maxLength={100} isRequired description='Printed as "Specimen: …"' value={label} onChange={(v) => { setLabel(v); setLabelTouched(true); }} />
      <Switch label="Active" isSelected={active} onChange={setActive} />
    </EditorDialog>
  );
}

function ContainersTab({ rows, specimenTypes, permissions }: { rows: readonly Container[]; specimenTypes: readonly SpecimenType[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const [editing, setEditing] = useState<Container | 'new' | null>(null);
  const { shown, toolbar, search } = useListFilter(rows, (r) => r.name);
  const openNew = manage ? () => setEditing('new') : undefined;
  useListShortcuts(search, openNew);
  const typeName = new Map(specimenTypes.map((s) => [s.id, s.name]));
  const cols: Col<Container>[] = [
    { header: 'Code', cell: (r) => r.code },
    { header: 'Name', cell: (r) => r.name },
    { header: 'Additive', cell: (r) => r.additive || '—' },
    { header: 'Cap colour', cell: (r) => <CapColour name={r.cap_colour_display} /> },
    { header: 'Default specimen type', cell: (r) => (r.default_specimen_type_id ? (typeName.get(r.default_specimen_type_id) ?? '—') : '—') },
    { header: 'Status', cell: status },
  ];
  return (
    <>
      {openNew ? <Button variant="primary" onPress={openNew}>New container</Button> : null}
      {toolbar}
      <MasterTable caption="Containers" cols={cols} rows={shown} empty="No containers yet." emptyAction={openNew ? { label: 'New container', onPress: openNew } : undefined} onEdit={manage ? setEditing : undefined} />
      {editing ? <ContainerDialog item={editing === 'new' ? undefined : editing} specimenTypes={specimenTypes} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function ContainerDialog({ item, specimenTypes, onClose }: { item: Container | undefined; specimenTypes: readonly SpecimenType[]; onClose: () => void }) {
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [additive, setAdditive] = useState(item?.additive ?? '');
  const [cap, setCap] = useState(item?.cap_colour_display ?? '');
  const [typeId, setTypeId] = useState(item?.default_specimen_type_id);
  const [active, setActive] = useState(item?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  const options = specimenTypes.filter((s) => s.is_active || s.id === typeId).map((s) => ({ value: s.id, label: s.name }));
  const body = {
    name,
    ...(additive.trim() || item?.additive ? { additive: additive.trim() } : {}),
    ...(cap.trim() || item?.cap_colour_display ? { cap_colour_display: cap.trim() } : {}),
    ...(typeId ? { default_specimen_type_id: typeId } : {}),
    is_active: active,
  };
  return (
    <EditorDialog
      title={item ? 'Edit container' : 'New container'}
      savedText="Container saved."
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      save={(key) => (item ? updateMasterAction('container', item.id, item.version, changed(item, body)) : createMasterAction('container', { code, ...body }, key))}
    >
      <CodeField label="Code" name="code" maxLength={32} pattern={CODE_RE.source} patternHint={CODE_HINT} isRequired isReadOnly={!!item} value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Name" name="name" maxLength={100} isRequired value={name} onChange={setName} />
      <TextField label="Additive" name="additive" maxLength={60} value={additive} onChange={setAdditive} />
      <TextField label="Cap colour" name="cap_colour_display" maxLength={40} value={cap} onChange={setCap} />
      <Select label="Default specimen type" name="default_specimen_type_id" options={options} {...(typeId ? { value: typeId } : {})} onChange={setTypeId} />
      <Switch label="Active" isSelected={active} onChange={setActive} />
    </EditorDialog>
  );
}
