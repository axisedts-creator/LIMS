'use client';
// SCR-10 Comment codes (04-UI-UX §4): code, department (blank = all departments), text. Search is a code prefix, Department filter
// includes tenant-wide codes; both run over the loaded rows [CONV]. The code (and department) are create-only.
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { createCommentCodeAction, updateCommentCodeAction } from '../server/catalogActions';
import { COMMENT_CODE_RE, type CommentCode, type Department } from '../server/types';
import { DUPLICATE, EditorDialog, MasterTable, StatusBadge, canManage, changed, useListShortcuts, type Col } from './master-ui';

const ALL = 'all';
const HELP = 'Technologists type :CODE followed by a space in the result comment to insert this text. Changing the text later does not change results already saved.';
const preview = (t: string) => (t.length > 80 ? `${t.slice(0, 80)}…` : t);

export function CommentCodesScreen({ commentCodes, departments, permissions }: { commentCodes: readonly CommentCode[]; departments: readonly Department[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const [editing, setEditing] = useState<CommentCode | 'new' | null>(null);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState<string>(ALL);
  const search = useRef<HTMLDivElement>(null);
  const openNew = manage ? () => setEditing('new') : undefined;
  useListShortcuts(search, openNew);
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const needle = q.trim().toLowerCase();
  const rows = commentCodes.filter((c) => (dept === ALL || !c.department_id || c.department_id === dept) && (!needle || c.code.toLowerCase().startsWith(needle)));
  const cols: Col<CommentCode>[] = [
    { header: 'Code', cell: (r) => r.code },
    { header: 'Department', cell: (r) => (r.department_id ? (deptName.get(r.department_id) ?? '—') : 'All departments') },
    { header: 'Text', cell: (r) => preview(r.text) },
    { header: 'Status', cell: (r) => <StatusBadge active={r.is_active} /> },
    { header: 'Version', cell: (r) => String(r.version) },
  ];
  return (
    <section aria-label="Comment codes">
      <PageHeader title="Comment codes" helpKey="catalog.comment_codes" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Comment codes' }]} actions={openNew ? <Button variant="primary" onPress={openNew}>New comment code</Button> : null} />
      <div className="lims-filter-bar">
        <div ref={search}>
          <TextField label="Search" name="q" maxLength={16} description="Code prefix" value={q} onChange={setQ} />
        </div>
        <Select label="Department" name="department_filter" options={[{ value: ALL, label: 'All departments' }, ...departments.map((d) => ({ value: d.id, label: d.name }))]} value={dept} onChange={setDept} />
      </div>
      <MasterTable
        caption="Comment codes"
        cols={cols}
        rows={rows}
        empty="No comment codes for this department."
        emptyAction={openNew ? { label: 'New comment code', onPress: openNew } : undefined}
        codeOf={(r) => r.code}
        onEdit={manage ? setEditing : undefined}
      />
      {editing ? <CommentCodeDialog item={editing === 'new' ? undefined : editing} departments={departments} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function CommentCodeDialog({ item, departments, onClose }: { item: CommentCode | undefined; departments: readonly Department[]; onClose: () => void }) {
  const [code, setCode] = useState(item?.code ?? '');
  const [dept, setDept] = useState<string>(item?.department_id ?? ALL);
  const [text, setText] = useState(item?.text ?? '');
  const [active, setActive] = useState(item?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  return (
    <EditorDialog
      title={item ? 'Edit comment code' : 'New comment code'}
      savedText="Comment code saved."
      reloadLabel="Refresh"
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      save={(key) =>
        item
          ? updateCommentCodeAction(item.id, item.version, changed(item, { text, is_active: active }))
          : createCommentCodeAction({ code, ...(dept !== ALL ? { department_id: dept } : {}), text }, key)
      }
    >
      <CodeField label="Code" name="code" maxLength={16} pattern={COMMENT_CODE_RE.source} patternHint="Capital letters A-Z, digits and _, up to 16." isRequired isReadOnly={!!item} value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <Select label="Department" name="department_id" isReadOnly={!!item} options={[{ value: ALL, label: 'All departments' }, ...departments.map((d) => ({ value: d.id, label: d.name }))]} value={dept} onChange={setDept} />
      <TextArea label="Text" name="text" maxLength={2000} rows={5} isRequired description={HELP} value={text} onChange={setText} />
      {item ? <Switch label="Active" isSelected={active} onChange={setActive} /> : null}
    </EditorDialog>
  );
}
