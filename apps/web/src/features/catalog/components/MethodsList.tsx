'use client';
// SCR-04 Methods (04-UI-UX §4, SCR-02 pattern): Code · Name · Status · Updated. Name ≤ 120.
import { useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { DateText } from '@lims/ui/components/DateText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { createMasterAction, updateMasterAction } from '../server/actions';
import { CODE_RE, type Method } from '../server/types';
import { CODE_HINT, DUPLICATE, EditorDialog, MasterTable, canManage, changed, statusText, useListFilter, useListShortcuts, type Col } from './master-ui';

export function MethodsList({ methods, permissions }: { methods: readonly Method[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const [editing, setEditing] = useState<Method | 'new' | null>(null);
  const { shown, toolbar, search } = useListFilter(methods, (m) => m.name);
  const openNew = manage ? () => setEditing('new') : undefined;
  useListShortcuts(search, openNew);

  const cols: Col<Method>[] = [
    { header: 'Code', cell: (m) => m.code },
    { header: 'Name', cell: (m) => m.name },
    { header: 'Status', cell: (m) => <Badge tone={m.is_active ? 'success' : 'neutral'}>{statusText(m.is_active)}</Badge> },
    { header: 'Updated', cell: (m) => <DateText value={m.updated_at as never} withTime /> },
  ];

  return (
    <section aria-label="Methods">
      <PageHeader title="Methods" helpKey="catalog.methods" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Methods' }]} actions={openNew ? <Button variant="primary" onPress={openNew}>New method</Button> : null} />
      {toolbar}
      <MasterTable caption="Methods" cols={cols} rows={shown} empty="No methods yet." emptyAction={openNew ? { label: 'New method', onPress: openNew } : undefined} onEdit={manage ? setEditing : undefined} />
      {editing ? <MethodDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function MethodDialog({ item, onClose }: { item: Method | undefined; onClose: () => void }) {
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [active, setActive] = useState(item?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  const body = { name, is_active: active };

  return (
    <EditorDialog
      title={item ? 'Edit method' : 'New method'}
      savedText="Method saved."
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      save={(key) => (item ? updateMasterAction('method', item.id, item.version, changed(item, body)) : createMasterAction('method', { code, ...body }, key))}
    >
      <CodeField label="Code" name="code" maxLength={32} pattern={CODE_RE.source} patternHint={CODE_HINT} isRequired isReadOnly={!!item} value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Name" name="name" maxLength={120} isRequired value={name} onChange={setName} />
      <Switch label="Active" isSelected={active} onChange={setActive} />
    </EditorDialog>
  );
}
