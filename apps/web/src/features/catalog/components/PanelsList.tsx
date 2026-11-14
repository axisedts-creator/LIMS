'use client';
// SCR-09 Panels & packages — list (04-UI-UX §4). Kind and Status filters run over the loaded rows [CONV]; rows open the detail page.
// "New panel" is a dialog: general fields + at least one member. Manage affordances are a UI hint; the API enforces.
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { Banner } from '@lims/ui/components/Banner';
import { createPanelAction } from '../server/catalogActions';
import { PANEL_CODE_RE, type Department, type OrderableSummary, type Panel, type PanelMember } from '../server/types';
import { DUPLICATE, EditorDialog, MasterTable, StatusBadge, canManage, useListFilter, useListShortcuts, type Col } from './master-ui';
import { MembersEditor, infoOf, toPayload, type Info } from './PanelMembers';

export const PACKAGE_COPY = 'Packages are priced as one item. Component prices are not added up.'; // AC-07.6
export const kindLabel = (k: Panel['panel_kind']) => (k === 'package' ? 'Package' : 'Clinical panel');
export const sexLabel = (s: Panel['sex_restriction']) => (s === 'male' ? 'Male' : s === 'female' ? 'Female' : '—');
export const SEX_OPTIONS = [{ value: 'none', label: 'None' }, { value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }] as const;
type KindFilter = 'all' | Panel['panel_kind'];

export function PanelsList({ panels, departments, permissions }: { panels: readonly Panel[]; departments: readonly Department[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<KindFilter>('all');
  const { shown, toolbar, search } = useListFilter(panels, (r) => r.name);
  const openNew = manage ? () => setCreating(true) : undefined;
  useListShortcuts(search, openNew);
  const rows = shown.filter((p) => kind === 'all' || p.panel_kind === kind);
  const cols: Col<Panel>[] = [
    { header: 'Code', cell: (r) => <a className="lims-link" href={`/catalog/panels/${r.id}`}>{r.code}</a> },
    { header: 'Name', cell: (r) => r.name },
    { header: 'Kind', cell: (r) => kindLabel(r.panel_kind) },
    { header: 'Sex restriction', cell: (r) => sexLabel(r.sex_restriction) },
    { header: 'Members', cell: (r) => String(r.members.length) },
    { header: 'Status', cell: (r) => <StatusBadge active={r.is_active} /> },
  ];
  return (
    <section aria-label="Panels & packages">
      <PageHeader title="Panels & packages" helpKey="catalog.panels" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Panels & packages' }]} actions={openNew ? <Button variant="primary" onPress={openNew}>New panel</Button> : null} />
      <div className="lims-filter-bar">
        <RadioGroup<KindFilter>
          label="Kind"
          name="kind"
          orientation="horizontal"
          value={kind}
          onChange={setKind}
          options={[{ value: 'all', label: 'All' }, { value: 'clinical', label: 'Clinical panel' }, { value: 'package', label: 'Package' }]}
        />
      </div>
      {toolbar}
      <MasterTable caption="Panels & packages" cols={cols} rows={rows} empty="No panels yet." emptyAction={openNew ? { label: 'New panel', onPress: openNew } : undefined} />
      {creating ? <PanelDialog departments={departments} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function PanelDialog({ departments, onClose }: { departments: readonly Department[]; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Panel['panel_kind']>('clinical');
  const [sex, setSex] = useState<string>('none');
  const [dept, setDept] = useState<string>('none');
  const [members, setMembers] = useState<PanelMember[]>([]);
  const info = useRef(new Map<string, Info>());
  const [membersError, setMembersError] = useState<string>();
  const [codeError, setCodeError] = useState<string>();
  const add = (o: OrderableSummary) => {
    info.current.set(o.id, infoOf(o));
    setMembers((m) => [...m, { kind: o.kind, orderable_id: o.id, sort_order: m.length }]);
    setMembersError(undefined);
  };
  return (
    <EditorDialog
      width="lg"
      title="New panel"
      savedText="Panel saved."
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      check={() => {
        if (members.length === 0) setMembersError('Add at least one test or panel.');
        return members.length > 0;
      }}
      save={(key) =>
        createPanelAction(
          { code, name, panel_kind: kind, ...(sex !== 'none' ? { sex_restriction: sex } : {}), ...(dept !== 'none' ? { department_id: dept } : {}), members: toPayload(members) },
          key,
        )
      }
    >
      <CodeField label="Code" name="code" maxLength={32} pattern={PANEL_CODE_RE.source} patternHint="Capital letters, digits and _ - + . up to 32." isRequired value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Name" name="name" maxLength={200} isRequired value={name} onChange={setName} />
      <RadioGroup<Panel['panel_kind']> label="Panel kind" name="panel_kind" value={kind} onChange={setKind} options={[{ value: 'clinical', label: 'Clinical panel' }, { value: 'package', label: 'Package' }]} />
      {kind === 'package' ? <p role="note">{PACKAGE_COPY}</p> : null}
      <Select label="Sex restriction" name="sex_restriction" options={SEX_OPTIONS} value={sex} onChange={setSex} />
      <Select label="Department" name="department_id" options={[{ value: 'none', label: 'None' }, ...departments.map((d) => ({ value: d.id, label: d.name }))]} value={dept} onChange={setDept} />
      {membersError ? <div role="alert"><Banner tone="danger" title={membersError} /></div> : null}
      <MembersEditor members={members} info={info.current} canEdit onAdd={add} onRemove={(i) => setMembers((m) => m.filter((_, j) => j !== i))} />
    </EditorDialog>
  );
}
