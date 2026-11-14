'use client';
// AD-6 Branches / AD-7 Collection centres (US-C1): table, row click → right Drawer editor (LD-140). Code is immutable after create;
// edits PATCH only changed fields with If-Match; deactivate never deletes (AC-C1.2).
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { createUnit, setUnitActive, updateUnit, type UnitKind } from '../actions';
import { Grid } from '../Grid';
import { Alert, Field, Picker, Radios, useFailure } from '../ui';
import { UNIT_CODE_RE, copyFor, type Branch, type Centre } from '../lib';

type Unit = (Branch | Centre) & Record<string, unknown>;
const KIND_LABEL: Record<string, string> = { own: 'Own', franchise: 'Franchise', home_collection: 'Home collection' };
const idOf = (kind: UnitKind, u: Unit) => String(kind === 'branches' ? u['branch_id'] : u['centre_id']);

export function OrgUnits({ kind, units: initial, branches, canEdit }: { kind: UnitKind; units: Unit[]; branches: Branch[]; canEdit: boolean }) {
  const toast = useToast();
  const [units, setUnits] = useState(initial);
  const [editing, setEditing] = useState<Unit | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Unit | null>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const centres = kind === 'centres';
  const branchName = new Map(branches.map((b) => [b.branch_id, b.name]));
  const upsert = (u: Unit) => setUnits((xs) => (xs.some((x) => idOf(kind, x) === idOf(kind, u)) ? xs.map((x) => (idOf(kind, x) === idOf(kind, u) ? u : x)) : [...xs, u]));
  const noun = centres ? 'centre' : 'branch';

  return (
    <main className="lims-page">
      <header className="lims-page-header">
        <h1>{centres ? 'Collection centres' : 'Branches'}</h1>
        {canEdit ? <Button variant="primary" onPress={() => setEditing('new')}>{`New ${noun}`}</Button> : null}
      </header>
      {units.length === 0 ? (
        <p>{centres ? 'Add your first collection centre. Home collection can be added as its own centre.' : 'Add your first branch.'}</p>
      ) : (
        <Grid
          label={centres ? 'Collection centres' : 'Branches'}
          columns={centres ? ['Code', 'Name', 'Branch', 'Type', 'Phone', 'Status'] : ['Code', 'Name', 'Processing lab', 'Phone', 'Status']}
          rows={units.map((u) => ({
            key: idOf(kind, u),
            onClick: () => setEditing(u),
            cells: [
              u.code,
              <button key="n" type="button" className="lims-link" onClick={(e) => { e.stopPropagation(); setEditing(u); }}>{u.name}</button>,
              ...(centres ? [branchName.get(String(u['branch_id'])) ?? '—', KIND_LABEL[String(u['kind'])] ?? String(u['kind'])] : [u['is_processing_lab'] ? 'Yes' : 'No']),
              u.phone ?? '—',
              u.is_active ? 'Active' : 'Inactive',
            ],
          }))}
        />
      )}
      {editing ? (
        <Editor kind={kind} unit={editing === 'new' ? null : editing} branches={branches} canEdit={canEdit}
          onClose={() => setEditing(null)}
          onSaved={(u, created) => { upsert(u); setEditing(null); toast.show({ tone: 'success', title: created ? `${centres ? 'Centre' : 'Branch'} created.` : 'Saved.' }); }}
          onToggle={(u) => { setEditing(null); setConfirmErr(null); setConfirm(u); }} />
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={confirm.is_active ? `Deactivate this ${noun}?` : `Reactivate this ${noun}?`}
          body={<>{confirmErr ? <Alert text={confirmErr} /> : null}<p>{confirm.is_active ? 'It stays listed and in history, but cannot be chosen for new work.' : 'It can be chosen for new work again.'}</p></>}
          confirmLabel={confirm.is_active ? 'Deactivate' : 'Reactivate'}
          tone={confirm.is_active ? 'danger' : 'default'}
          isOpen
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const r = await setUnitActive(kind, idOf(kind, confirm), confirm.version, !confirm.is_active);
            if (!r.ok) { setConfirmErr(copyFor(r.code)); return; }
            upsert({ ...confirm, ...(r.data as Partial<Unit>), is_active: !confirm.is_active } as Unit);
            setConfirm(null);
            toast.show({ tone: 'success', title: 'Saved.' });
          }}
        />
      ) : null}
    </main>
  );
}

function Editor({ kind, unit, branches, canEdit, onClose, onSaved, onToggle }: {
  kind: UnitKind; unit: Unit | null; branches: Branch[]; canEdit: boolean; onClose: () => void; onSaved: (u: Unit, created: boolean) => void; onToggle: (u: Unit) => void;
}) {
  const centres = kind === 'centres';
  const init = {
    code: unit?.code ?? '', name: unit?.name ?? '', address_text: unit?.address_text ?? '', phone: unit?.phone ?? '',
    branch_id: String(unit?.['branch_id'] ?? (branches.length === 1 ? branches[0]!.branch_id : '')), kind: String(unit?.['kind'] ?? 'own'),
    is_processing_lab: unit ? Boolean(unit['is_processing_lab']) : true,
  };
  const [v, setV] = useState(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const failure = useFailure();
  const set = <K extends keyof typeof v>(k: K) => (x: (typeof v)[K]) => setV((s) => ({ ...s, [k]: x }));

  const save = async () => {
    if (busy) return;
    const e: Record<string, string> = {};
    if (!unit && !UNIT_CODE_RE.test(v.code)) e['code'] = 'Use 1–16 letters, digits or -';
    if (!v.name.trim() || v.name.length > 120) e['name'] = 'Enter 1–120 characters';
    if (v.address_text.length > 300) e['address_text'] = 'Use 300 characters or fewer';
    if (v.phone.length > 30) e['phone'] = 'Use 30 characters or fewer';
    if (centres && !v.branch_id) e['branch_id'] = 'Choose a branch';
    setErrors(e);
    failure.clear();
    if (Object.keys(e).length) return;
    const fields = centres ? (['name', 'branch_id', 'kind', 'address_text', 'phone'] as const) : (['name', 'address_text', 'phone', 'is_processing_lab'] as const);
    const val = (k: (typeof fields)[number]) => (typeof v[k] === 'string' ? (v[k] as string).trim() : v[k]);
    setBusy(true);
    let r;
    if (unit) {
      const patch: Record<string, unknown> = {};
      const unset: string[] = [];
      for (const k of fields) {
        if (val(k) === init[k]) continue;
        if (val(k) === '' && (k === 'address_text' || k === 'phone')) unset.push(k); else patch[k] = val(k);
      }
      if (unset.length) patch['unset'] = unset;
      if (!Object.keys(patch).length) { setBusy(false); onClose(); return; }
      r = await updateUnit(kind, idOf(kind, unit), unit.version, patch);
    } else {
      const body: Record<string, unknown> = { code: v.code };
      for (const k of fields) if (val(k) !== '') body[k] = val(k);
      r = await createUnit(kind, body);
    }
    setBusy(false);
    if (!r.ok) {
      if (r.code === 'identity.code_duplicate') setErrors({ code: copyFor(r.code) });
      failure.set(r);
      return;
    }
    onSaved({ ...(unit ?? {}), ...(r.data as Record<string, unknown>) } as Unit, !unit);
  };

  return (
    // LD-140 / 10-DESIGN-SYSTEM §4 Masters: list + right drawer (one short section, so one Save). Kit Drawer has no footer slot.
    <Drawer title={unit ? `Edit ${centres ? 'centre' : 'branch'}` : `New ${centres ? 'centre' : 'branch'}`} isOpen onClose={onClose}>
      {failure.banner}
      <Field label="Code" value={v.code} onChange={set('code')} readOnly={!!unit || !canEdit} error={errors['code']} hint="Printed on reports, e.g. C000000002" required={!unit} />
      <Field label="Name" value={v.name} onChange={set('name')} readOnly={!canEdit} error={errors['name']} required />
      {centres ? (
        <>
          <Picker label="Branch" value={v.branch_id ? [v.branch_id] : []} onChange={(x) => set('branch_id')(x[0] ?? '')} error={errors['branch_id']} disabled={!canEdit}
            options={branches.filter((b) => b.is_active || b.branch_id === v.branch_id).map((b) => ({ value: b.branch_id, label: b.name }))} />
          <Radios legend="Type" name="kind" value={v.kind} onChange={set('kind')} disabled={!canEdit}
            options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
        </>
      ) : null}
      <Field label="Address" multiline value={v.address_text} onChange={set('address_text')} readOnly={!canEdit} error={errors['address_text']} />
      <Field label="Phone" type="tel" value={v.phone} onChange={set('phone')} readOnly={!canEdit} error={errors['phone']} />
      {!centres ? <Switch label="Processing lab" isSelected={v.is_processing_lab} onChange={set('is_processing_lab')} isDisabled={!canEdit} /> : null}
      {canEdit ? (
        <div className="lims-dialog-footer">
          {unit ? <Button variant="ghost" onPress={() => onToggle(unit)}>{unit.is_active ? 'Deactivate' : 'Reactivate'}</Button> : null}
          <Button variant="primary" onPress={() => void save()} isLoading={busy}>Save</Button>
        </div>
      ) : null}
      {failure.dialogs}
    </Drawer>
  );
}
