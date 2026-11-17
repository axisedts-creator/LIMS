'use client';
// SR-04 "Body systems" (PUT #17) and "Analyte mapping" (PUT #14 / DELETE #15). Edits go through a Drawer; every write carries the row version as If-Match.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { putGroupAction, putMappingAction, removeAction } from '../server/actions';
import type { Group, Mapping, Option } from '../library';
import { ErrorAlert, byField, useEditor } from './common';

const yes = (b?: boolean) => (b ? 'Yes' : 'No');

export function GroupsTab({ groups }: { groups: Group[] }) {
  const ed = useEditor();
  const [editing, setEditing] = useState<Group>();
  const columns: ColumnDef<Group>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (g) => g.group_code },
    { id: 'en', header: 'Display (English)', cell: (g) => g.display_en },
    { id: 'ne', header: 'Display (Nepali)', cell: (g) => (g.display_ne ? <span lang="ne">{g.display_ne}</span> : '—') },
    { id: 'weight', header: 'Weight', align: 'end', cell: (g) => String(g.score_weight) },
    { id: 'order', header: 'Order', align: 'end', cell: (g) => String(g.sort_order) },
    { id: 'shown', header: 'Shown', cell: (g) => <Switch label={g.is_shown ? 'Shown' : 'Hidden'} isSelected={g.is_shown} isDisabled /> },
    ...(ed.readOnly ? [] : [{ id: 'actions', header: 'Actions', cell: (g: Group) => <Button size="sm" variant="ghost" onPress={() => setEditing(g)}>Edit</Button> }]),
  ];
  return (
    <div>
      <DataTable columns={columns} rows={groups} getRowId={(g) => g.group_code} caption="Body systems" density="compact" emptyState={{ title: 'No body systems yet' }} />
      {editing ? <GroupDrawer group={editing} onClose={() => setEditing(undefined)} /> : null}
    </div>
  );
}

function GroupDrawer({ group, onClose }: { group: Group; onClose: () => void }) {
  const ed = useEditor();
  const [en, setEn] = useState(group.display_en);
  const [ne, setNe] = useState(group.display_ne ?? '');
  const [weight, setWeight] = useState<number | undefined>(group.score_weight);
  const [order, setOrder] = useState<number | undefined>(group.sort_order);
  const [shown, setShown] = useState(group.is_shown);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string>();

  const save = async () => {
    const e: Record<string, string> = {};
    if (!en.trim()) e['display_en'] = 'Display (English) is required.';
    else if (en.length > 60) e['display_en'] = 'Display (English) must be 60 characters or fewer.';
    if (ed.language === 'ne' && !ne.trim()) e['display_ne'] = 'Display (Nepali) is required for a Nepali library.';
    else if (ne.length > 60) e['display_ne'] = 'Display (Nepali) must be 60 characters or fewer.';
    if (weight === undefined || weight < 0 || weight > 10) e['score_weight'] = 'Weight must be between 0 and 10.';
    if (order === undefined) e['sort_order'] = 'Order is required.';
    setErrs(e);
    if (Object.keys(e).length) return;
    const r = await putGroupAction(ed.versionId, group.group_code, group.version, { display_en: en, ...(ne ? { display_ne: ne } : {}), score_weight: weight!, sort_order: order!, is_shown: shown });
    if (r.ok) { onClose(); ed.saved(); return; }
    setAlert(ed.failed(r));
    setErrs(byField(r.errors));
  };
  const err = (f: string) => (errs[f] ? { error: errs[f] } : {});

  return (
    <Drawer title={`Edit body system ${group.group_code}`} isOpen onClose={onClose}>
      <ErrorAlert text={alert} />
      <Form onSubmit={save} errorSummary={false}>
        {/* [CONV] input caps above the 60 limit so an over-long paste is reported, not silently cut */}
        <TextField label="Display (English)" name="display_en" maxLength={200} value={en} onChange={setEn} {...err('display_en')} />
        <TextField label="Display (Nepali)" name="display_ne" maxLength={200} value={ne} onChange={setNe} {...err('display_ne')} />
        {/* ponytail: kit IntegerField drops "-" when min >= 0; a wider typing range lets the 0–10 check report it */}
        <IntegerField label="Weight" name="score_weight" min={-99} max={99} description="0–10" {...(weight !== undefined ? { value: weight } : {})} onChange={setWeight} {...err('score_weight')} />
        <IntegerField label="Order" name="sort_order" min={0} max={9999} {...(order !== undefined ? { value: order } : {})} onChange={setOrder} {...err('sort_order')} />
        <Switch label="Shown" isSelected={shown} onChange={setShown} />
        <Button type="submit" variant="primary">Save</Button>
      </Form>
    </Drawer>
  );
}

export function MappingTab({ mappings, groupName, organGroups, minMapped }: { mappings: Mapping[]; groupName: (c?: string) => string; organGroups: Option[]; minMapped: number }) {
  const ed = useEditor();
  const router = useRouter();
  const [editing, setEditing] = useState<Mapping>();
  const [removing, setRemoving] = useState<Mapping>();
  const [alert, setAlert] = useState<string>();

  const remove = async () => {
    if (!removing) return;
    const r = await removeAction(ed.versionId, 'mapping', removing.analyte_id, removing.version);
    setRemoving(undefined);
    if (r.ok) { setAlert(undefined); router.refresh(); } else setAlert(ed.failed(r));
  };

  const overrides = (m: Mapping) => [
    m.borderline_fraction_bp !== undefined ? `Borderline ${m.borderline_fraction_bp / 100} %` : '', m.trend_stable_bp !== undefined ? `Stable ${m.trend_stable_bp / 100} %` : '',
  ].filter(Boolean).join(', ') || '—';
  const columns: ColumnDef<Mapping>[] = [
    { id: 'analyte', header: 'Analyte', isRowHeader: true, cell: (m) => m.analyte_name ?? 'Name unavailable' },
    { id: 'test', header: 'Test', cell: (m) => m.test_name ?? '—' },
    { id: 'group', header: 'Body system', cell: (m) => groupName(m.group_code) },
    { id: 'score', header: 'In score', cell: (m) => yes(m.include_in_score !== false) },
    { id: 'trend', header: 'Trend', cell: (m) => yes(m.trend_enabled === true) },
    { id: 'overrides', header: 'Overrides', cell: overrides },
    ...(ed.readOnly ? [] : [{
      id: 'actions', header: 'Actions',
      cell: (m: Mapping) => (
        <span className="lims-inline">
          <Button size="sm" variant="ghost" onPress={() => setEditing(m)}>Edit</Button>
          <Button size="sm" variant="ghost" onPress={() => setRemoving(m)}>Remove</Button>
        </span>
      ),
    }]),
  ];

  return (
    <div>
      <ErrorAlert text={alert} />
      {mappings.length === 0 ? <p>{`No analytes mapped yet — summaries need at least ${minMapped} mapped results`}</p> : (
        <DataTable columns={columns} rows={mappings} getRowId={(m) => m.analyte_id} caption="Analyte mapping" density="compact" emptyState={{ title: 'No analytes mapped yet' }} />
      )}
      {editing ? <MappingDrawer mapping={editing} organGroups={organGroups} onClose={() => setEditing(undefined)} /> : null}
      <ConfirmDialog
        title="Remove this mapping?" body="The analyte will no longer count towards this body system in this version." confirmLabel="Remove" tone="danger"
        isOpen={!!removing} onCancel={() => setRemoving(undefined)} onConfirm={remove}
      />
    </div>
  );
}

function MappingDrawer({ mapping, organGroups, onClose }: { mapping: Mapping; organGroups: Option[]; onClose: () => void }) {
  const ed = useEditor();
  const [group, setGroup] = useState(mapping.group_code);
  const [inScore, setInScore] = useState(mapping.include_in_score !== false);
  const [trend, setTrend] = useState(mapping.trend_enabled === true);
  const [alert, setAlert] = useState<string>();
  const [errs, setErrs] = useState<Record<string, string>>({});

  const save = async () => {
    if (!group) { setErrs({ group_code: 'Body system is required.' }); return; }
    const body = {
      group_code: group, include_in_score: inScore, trend_enabled: trend,
      ...(mapping.borderline_fraction_bp !== undefined ? { borderline_fraction_bp: mapping.borderline_fraction_bp } : {}),
      ...(mapping.trend_stable_bp !== undefined ? { trend_stable_bp: mapping.trend_stable_bp } : {}),
      ...(mapping.sort_order !== undefined ? { sort_order: mapping.sort_order } : {}),
    };
    const r = await putMappingAction(ed.versionId, mapping.analyte_id, mapping.version, body);
    if (r.ok) { onClose(); ed.saved(); return; }
    setAlert(ed.failed(r));
    setErrs(byField(r.errors));
  };

  return (
    <Drawer title={`Edit mapping: ${mapping.analyte_name ?? 'analyte'}`} isOpen onClose={onClose}>
      <ErrorAlert text={alert} />
      <Form onSubmit={save} errorSummary={false}>
        <Select label="Body system" name="group_code" options={organGroups} value={group} onChange={setGroup} {...(errs['group_code'] ? { error: errs['group_code'] } : {})} />
        <Checkbox label="Include in score" isSelected={inScore} onChange={setInScore} />
        <Checkbox label="Show trend" isSelected={trend} onChange={setTrend} />
        <Button type="submit" variant="primary">Save</Button>
      </Form>
    </Drawer>
  );
}
