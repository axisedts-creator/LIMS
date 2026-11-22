'use client';
// SCR-05 Units & value sets (04-UI-UX §4). Global rows are read-only ("Provided by the system"). Value-set values are edited
// in a grid; after 409 catalog.version_in_use the Order column and row removal become read-only (03-APP-FLOW §5).
import { useRef, useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { DataTable } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { createMasterAction, updateMasterAction } from '../server/actions';
import { UNIT_CODE_RE, VALUE_CODE_RE, VALUE_SET_CODE_RE, type Unit, type ValueSet, type ValueSetValue } from '../server/types';
import { DUPLICATE, EditorDialog, MasterTable, canManage, changed, statusText, useListFilter, useListShortcuts, type Col } from './master-ui';
import { t } from '@/core/i18n/messages';

const scope = (r: { scope: 'global' | 'tenant' }) => (r.scope === 'global' ? 'Global' : 'Lab');
const SYSTEM = 'Provided by the system';
// 10-DESIGN-SYSTEM §6: no emoji; system rows say so with a text Badge (named "Provided by the system") instead of a lock glyph.
const lock = (r: { scope: string }) => (r.scope === 'global' ? <span role="img" aria-label={SYSTEM} title={SYSTEM}><Badge tone="neutral">System</Badge></span> : null);
const IN_USE = 'This value set is used by a published analyte version; values can be added or hidden, not removed or re-ordered.';

const READ_ONLY = 'You can view units and value sets. Adding or changing them needs the catalog manage permission.'; // [CONV]

export function UnitsScreen({ units, valueSets, permissions }: { units: readonly Unit[]; valueSets: readonly ValueSet[]; permissions: readonly string[] }) {
  const [tab, setTab] = useState('units');
  const manage = canManage(permissions);
  // T0D-CATUNITS-1 (LD-310): the New button lives in the page header and follows the open tab.
  const [unitEditing, setUnitEditing] = useState<Unit | 'new' | null>(null);
  const [setEditing, setSetEditing] = useState<ValueSet | 'new' | null>(null);
  const action = !manage ? null : tab === 'units'
    ? <Button variant="primary" onPress={() => setUnitEditing('new')}>New unit</Button>
    : <Button variant="primary" onPress={() => setSetEditing('new')}>New value set</Button>;
  return (
    <section aria-label="Units & value sets">
      <PageHeader title={t('catalog.nav.units')} helpKey="catalog.units" {...(action ? { actions: action } : {})} />
      {manage ? null : <p className="lims-state-body">{READ_ONLY}</p>}
      <Tabs aria-label="Units & value sets" items={[{ id: 'units', label: 'Units' }, { id: 'value_sets', label: 'Value sets' }]} selectedId={tab} onChange={setTab}>
        {tab === 'units'
          ? <UnitsTab rows={units} manage={manage} editing={unitEditing} setEditing={setUnitEditing} />
          : <ValueSetsTab rows={valueSets} manage={manage} editing={setEditing} setEditing={setSetEditing} />}
      </Tabs>
    </section>
  );
}

function UnitsTab({ rows, manage, editing, setEditing }: { rows: readonly Unit[]; manage: boolean; editing: Unit | 'new' | null; setEditing: (u: Unit | 'new' | null) => void }) {
  const openNew = manage ? () => setEditing('new') : undefined;
  // T0D-UILIST-3 (LD-353 template 1): the shared search + status filter row.
  const { shown, toolbar, search } = useListFilter(rows, (r) => r.display);
  useListShortcuts(search, openNew);
  const cols: Col<Unit>[] = [
    { header: 'Code', cell: (r) => r.code },
    { header: 'Display', cell: (r) => r.display },
    { header: 'Scope', cell: scope },
    { header: 'Status', cell: (r) => <Badge tone={r.is_active ? 'success' : 'neutral'}>{statusText(r.is_active)}</Badge> },
  ];
  const tenantOnly = rows.length > 0 && !rows.some((r) => r.scope === 'tenant');
  return (
    <>
      {tenantOnly ? <p className="lims-state-body">Only global units are available. Add a lab-specific unit if needed.</p> : null}
      {toolbar}
      <MasterTable caption="Units" cols={cols} rows={shown}empty="No test units yet. Add a unit" emptyAction={openNew ? { label: 'New unit', onPress: openNew } : undefined} rowExtra={lock} canEdit={(r) => r.scope === 'tenant'} onEdit={manage ? setEditing : undefined} />
      {editing ? <UnitDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function UnitDialog({ item, onClose }: { item: Unit | undefined; onClose: () => void }) {
  const [code, setCode] = useState(item?.code ?? '');
  const [display, setDisplay] = useState(item?.display ?? '');
  const [active, setActive] = useState(item?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  return (
    <EditorDialog
      title={item ? 'Edit lab unit' : 'New unit'}
      savedText="Unit saved."
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      check={() => {
        const ok = !!item || UNIT_CODE_RE.test(code);
        if (!ok) setCodeError('Use 1–32 letters, digits or _.'); // [CONV]
        return ok;
      }}
      save={(key) => (item ? updateMasterAction('unit', item.id, item.version, changed(item, { display, is_active: active })) : createMasterAction('unit', { code, display }, key))}
    >
      <TextField label="Code" name="code" maxLength={32} isRequired isReadOnly={!!item} description="Letters, digits and _ (case is kept)." value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Display" name="display" maxLength={32} isRequired description="e.g. 10^3/µL" value={display} onChange={setDisplay} />
      {item ? <Switch label="Active" isSelected={active} onChange={setActive} /> : null}
    </EditorDialog>
  );
}

function ValueSetsTab({ rows, manage, editing, setEditing }: { rows: readonly ValueSet[]; manage: boolean; editing: ValueSet | 'new' | null; setEditing: (v: ValueSet | 'new' | null) => void }) {
  const openNew = manage ? () => setEditing('new') : undefined;
  useListShortcuts(useRef(null), openNew);
  const cols: Col<ValueSet>[] = [
    { header: 'Code', cell: (r) => r.code },
    { header: 'Display', cell: (r) => r.display },
    { header: 'Ordered', cell: (r) => (r.is_ordered ? 'Yes' : 'No') },
    { header: 'Values', cell: (r) => String(r.values.length) },
    { header: 'Scope', cell: scope },
  ];
  return (
    <>
      <MasterTable caption="Value sets" cols={cols} rows={rows} empty="No value sets yet." emptyAction={openNew ? { label: 'New value set', onPress: openNew } : undefined} rowExtra={lock} canEdit={(r) => r.scope === 'tenant'} onEdit={manage ? setEditing : undefined} />
      {editing ? <ValueSetDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

type Draft = { code: string; display: string; order: string; is_active: boolean; saved: boolean };

function ValueSetDialog({ item, onClose }: { item: ValueSet | undefined; onClose: () => void }) {
  const [code, setCode] = useState(item?.code ?? '');
  const [display, setDisplay] = useState(item?.display ?? '');
  const [ordered, setOrdered] = useState(item?.is_ordered ?? false);
  const [values, setValues] = useState<Draft[]>(() => (item?.values ?? []).map((v: ValueSetValue) => ({ code: v.code, display: v.display, order: String(v.sort_order), is_active: v.is_active ?? true, saved: true })));
  const [inUse, setInUse] = useState(false);
  const [codeError, setCodeError] = useState<string>();
  const [gridError, setGridError] = useState<string>();
  const set = (i: number, patch: Partial<Draft>) => setValues((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const payload = () => values.map((v) => ({ code: v.code, display: v.display, sort_order: Number(v.order), is_active: v.is_active }));
  const check = () => {
    const bad = values.findIndex((v) => !VALUE_CODE_RE.test(v.code) || !v.display.trim() || v.display.length > 40 || !/^\d{1,4}$/.test(v.order));
    setGridError(bad >= 0 ? `Value ${bad + 1}: code 1–16 of A-Z 0-9 _ + -, display 1–40 characters, order 0–9999.` : undefined); // [CONV]
    return bad < 0;
  };
  return (
    <EditorDialog
      width="lg"
      title={item ? 'Edit value set' : 'New value set'}
      savedText="Value set saved."
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      onInUse={() => setInUse(true)}
      inUseText={IN_USE}
      check={check}
      save={(key) => (item ? updateMasterAction('value_set', item.id, item.version, { display, is_ordered: ordered, values: payload() }) : createMasterAction('value_set', { code, display, is_ordered: ordered, values: payload() }, key))}
    >
      <CodeField label="Code" name="code" maxLength={32} pattern={VALUE_SET_CODE_RE.source} patternHint="Pattern ^[A-Z0-9_]{1,32}$." isRequired isReadOnly={!!item} value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Display" name="display" maxLength={100} isRequired value={display} onChange={setDisplay} />
      <Switch label="Ordered" isSelected={ordered} onChange={setOrdered} />
      {gridError ? <div role="alert"><Banner tone="danger" title={gridError} /></div> : null}
      {/* T0D-UIX-2 (LD-442): the kit DataTable (density regular); saved values of an in-use set: no re-order, no removal (hide via Active instead) */}
      <DataTable<number>
        caption="Values"
        density="regular"
        rows={values.map((_, i) => i)}
        getRowId={(i) => String(i)}
        emptyState={{ title: 'No values yet.' }}
        columns={[
          { id: 'code', header: 'Code', isRowHeader: true, cell: (i) => <input className="lims-input" aria-label={`Value ${i + 1} code`} maxLength={16} value={values[i]!.code} readOnly={values[i]!.saved && !!item} onChange={(e) => set(i, { code: e.target.value.toUpperCase() })} /> },
          { id: 'display', header: 'Display', cell: (i) => <input className="lims-input" aria-label={`Value ${i + 1} display`} maxLength={40} value={values[i]!.display} onChange={(e) => set(i, { display: e.target.value })} /> },
          { id: 'order', header: 'Order', cell: (i) => <input className="lims-input" aria-label={`Value ${i + 1} order`} inputMode="numeric" maxLength={4} value={values[i]!.order} readOnly={inUse && values[i]!.saved} onChange={(e) => set(i, { order: e.target.value.replace(/\D/g, '') })} /> },
          { id: 'active', header: 'Active', cell: (i) => <input type="checkbox" aria-label={`Value ${i + 1} active`} checked={values[i]!.is_active} onChange={(e) => set(i, { is_active: e.target.checked })} /> },
          { id: 'actions', header: 'Actions', cell: (i) => (inUse && values[i]!.saved ? null : <Button size="sm" variant="ghost" onPress={() => setValues((vs) => vs.filter((_, j) => j !== i))}>Remove<VisuallyHidden> value {i + 1}</VisuallyHidden></Button>) },
        ]}
      />
      {values.length < 50 ? <Button size="sm" onPress={() => setValues((vs) => [...vs, { code: '', display: '', order: String(vs.length), is_active: true, saved: false }])}>Add value</Button> : null}
    </EditorDialog>
  );
}
