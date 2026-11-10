'use client';
// SCR-09 panel detail: General (code and kind are create-only), Members grid (own Save members → PUT, If-Match) and the live
// "Expanded tests" preview. Without catalog.test.manage everything is read-only text. Failures stay inline (cycle, inactive, stale).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { replacePanelMembersAction, updatePanelAction } from '../server/catalogActions';
import { PANEL_CODE_RE, type Department, type OrderableSummary, type Panel, type PanelMember } from '../server/types';
import { CONFLICT, MFA, SaveForm, StatusBadge, canManage } from './master-ui';
import { ExpandedTests, MembersEditor, infoOf, toPayload, type Info } from './PanelMembers';
import { PACKAGE_COPY, SEX_OPTIONS, kindLabel, sexLabel } from './PanelsList';

const MEMBER_ERRORS: Record<string, string> = {
  'catalog.panel_cycle': 'This would make the panel contain itself (P1 → P2 → P1).',
  'catalog.test_inactive': 'A member is inactive. Remove it or make it active again, then save.',
  'common.version_conflict': CONFLICT,
  'auth.mfa_required': MFA,
};

export function PanelDetail({ panel, departments, orderables, permissions }: { panel: Panel; departments: readonly Department[]; orderables: readonly OrderableSummary[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const router = useRouter();
  const toast = useToast();
  const deptName = departments.find((d) => d.id === panel.department_id)?.name;
  const info = useRef(new Map<string, Info>(orderables.map((o) => [o.id, infoOf(o)])));
  const saved = [...panel.members].sort((a, b) => a.sort_order - b.sort_order);
  const [members, setMembers] = useState<PanelMember[]>(saved);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dirty = members.map((m) => m.orderable_id).join() !== saved.map((m) => m.orderable_id).join();

  const [name, setName] = useState(panel.name);
  const [sex, setSex] = useState<string>(panel.sex_restriction ?? 'none');
  const [dept, setDept] = useState<string>(panel.department_id ?? 'none');
  const [active, setActive] = useState(panel.is_active);

  const saveGeneral = () => {
    const body: Record<string, unknown> = {};
    const unset: string[] = [];
    if (name !== panel.name) body['name'] = name;
    if (sex !== (panel.sex_restriction ?? 'none')) (sex === 'none' ? unset.push('sex_restriction') : (body['sex_restriction'] = sex));
    if (dept !== (panel.department_id ?? 'none')) (dept === 'none' ? unset.push('department_id') : (body['department_id'] = dept));
    if (active !== panel.is_active) body['is_active'] = active;
    if (unset.length) body['unset'] = unset;
    return updatePanelAction(panel.id, panel.version, body);
  };

  const saveMembers = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await replacePanelMembersAction(panel.id, panel.version, { members: toPayload(members) });
      if (r.ok) {
        toast.show({ tone: 'success', title: 'Members saved.' });
        router.refresh();
      } else setError(MEMBER_ERRORS[r.code] ?? 'Could not save the members. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Panel">
      <PageHeader
        title={panel.name}
        helpKey="catalog.panels"
        breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Panels & packages', href: '/catalog/panels' }, { label: panel.code }]}
        status={<StatusBadge active={panel.is_active} />}
      />
      {panel.panel_kind === 'package' ? <p role="note">{PACKAGE_COPY}</p> : null}
      {manage ? (
        <SaveForm savedText="Panel saved." keepOpen reloadLabel="Refresh" onDuplicate={() => undefined} save={() => saveGeneral()}>
          <CodeField label="Code" name="code" maxLength={32} pattern={PANEL_CODE_RE.source} patternHint="Set when the panel was created." isReadOnly value={panel.code} />
          <TextField label="Name" name="name" maxLength={200} isRequired value={name} onChange={setName} />
          <RadioGroup<Panel['panel_kind']> label="Panel kind" name="panel_kind" isDisabled value={panel.panel_kind} options={[{ value: 'clinical', label: 'Clinical panel' }, { value: 'package', label: 'Package' }]} />
          <Select label="Sex restriction" name="sex_restriction" options={SEX_OPTIONS} value={sex} onChange={setSex} />
          <Select label="Department" name="department_id" options={[{ value: 'none', label: 'None' }, ...departments.map((d) => ({ value: d.id, label: d.name }))]} value={dept} onChange={setDept} />
          <Switch label="Active" isSelected={active} onChange={setActive} />
        </SaveForm>
      ) : (
        <dl className="lims-dl">
          <dt>Code</dt><dd>{panel.code}</dd>
          <dt>Name</dt><dd>{panel.name}</dd>
          <dt>Kind</dt><dd>{kindLabel(panel.panel_kind)}</dd>
          <dt>Sex restriction</dt><dd>{sexLabel(panel.sex_restriction)}</dd>
          <dt>Department</dt><dd>{deptName ?? '—'}</dd>
        </dl>
      )}
      <h2 className="lims-section-title">Members</h2>
      {error ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
      <MembersEditor
        members={members}
        info={info.current}
        canEdit={manage}
        keepOne
        excludeId={panel.id}
        onAdd={(o) => {
          info.current.set(o.id, infoOf(o));
          setMembers((m) => [...m, { kind: o.kind, orderable_id: o.id, sort_order: m.length }]);
        }}
        onRemove={(i) => setMembers((m) => m.filter((_, j) => j !== i))}
      />
      {manage ? <Button variant="primary" isDisabled={!dirty || busy} onPress={() => void saveMembers()}>Save members</Button> : null}
      <ExpandedTests ids={members.map((m) => m.orderable_id)} />
    </section>
  );
}
