'use client';
// SCR-02 Departments (04-UI-UX §4): Code · Name · Report order · Report heading · Status · Updated; New / Edit dialog.
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { DateText } from '@lims/ui/components/DateText';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { createMasterAction, updateMasterAction } from '../server/actions';
import { CODE_RE, type Department } from '../server/types';
import { CODE_HINT, DUPLICATE, EditorDialog, MasterTable, canManage, changed, statusText, useListFilter, useListShortcuts, type Col } from './master-ui';

export function DepartmentsList({ departments, permissions }: { departments: readonly Department[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const [editing, setEditing] = useState<Department | 'new' | null>(useSearchParams().get('new') === '1' && manage ? 'new' : null);
  const { shown, toolbar, search } = useListFilter(departments, (d) => d.name);
  const openNew = manage ? () => setEditing('new') : undefined;
  useListShortcuts(search, openNew);

  const cols: Col<Department>[] = [
    { header: 'Code', cell: (d) => d.code },
    { header: 'Name', cell: (d) => d.name },
    { header: 'Report order', cell: (d) => String(d.report_order) },
    { header: 'Report heading', cell: (d) => d.report_heading ?? '—' },
    { header: 'Status', cell: (d) => <Badge tone={d.is_active ? 'success' : 'neutral'}>{statusText(d.is_active)}</Badge> },
    { header: 'Updated', cell: (d) => <DateText value={d.updated_at as never} withTime /> },
  ];

  return (
    <section aria-label="Departments">
      <PageHeader title="Departments" helpKey="catalog.departments" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Departments' }]} actions={openNew ? <Button variant="primary" onPress={openNew}>New department</Button> : null} />
      {toolbar}
      <MasterTable caption="Departments" cols={cols} rows={shown} empty="No departments yet." emptyAction={openNew ? { label: 'New department', onPress: openNew } : undefined} onEdit={manage ? setEditing : undefined} />
      {editing ? <DepartmentDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function DepartmentDialog({ item, onClose }: { item: Department | undefined; onClose: () => void }) {
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [order, setOrder] = useState<number | undefined>(item?.report_order ?? 100);
  const [heading, setHeading] = useState(item?.report_heading ?? '');
  const [active, setActive] = useState(item?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  const body = { name, report_order: order!, ...(heading.trim() || item?.report_heading ? { report_heading: heading.trim() } : {}), is_active: active };

  return (
    <EditorDialog
      title={item ? 'Edit department' : 'New department'}
      savedText="Department saved."
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      save={(key) => (item ? updateMasterAction('department', item.id, item.version, changed(item, body)) : createMasterAction('department', { code, ...body }, key))}
    >
      <CodeField label="Code" name="code" maxLength={32} pattern={CODE_RE.source} patternHint={CODE_HINT} isRequired isReadOnly={!!item} value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Name" name="name" maxLength={100} isRequired value={name} onChange={setName} />
      <IntegerField label="Report order" name="report_order" min={0} max={9999} isRequired {...(order !== undefined ? { value: order } : {})} onChange={setOrder} />
      <TextField label="Report heading" name="report_heading" maxLength={100} value={heading} onChange={setHeading} />
      <Switch label="Active" isSelected={active} onChange={setActive} />
    </EditorDialog>
  );
}
