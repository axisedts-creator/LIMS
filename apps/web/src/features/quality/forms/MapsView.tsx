'use client';
// 04-UI-UX §2.6 Maps tab: control-ID maps (analyser control id + optional lot as sent -> our lot). LD-140: @lims/ui only.
// helpKey of this screen is set by SetupShell (quality.setup_maps). The instrument picker reads C7 through the BFF and degrades to an id field.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextField } from '@lims/ui/components/TextField';
import { createMapAction, deactivateMapAction } from './actions';
import { FormDialog, FormMessage, InstrumentPicker, err, lotOptions, useSetupAction } from './fields';
import { SetupShell } from './SetupShell';
import type { IdMap, Material, Picked } from './types';
import { validateMap } from './validate';

export interface MapPrefill { instrument_id?: string; control_id?: string; control_lot?: string }
const POINTERS: Record<string, string> = { '/instrument_id': 'instrument', '/control_id_raw': 'control_id', '/control_lot_raw': 'control_lot', '/lot_id': 'lot' };

export function MapsView({ rows, materials, canManage, pickInstruments, prefill }: { rows: IdMap[]; materials: Material[]; canManage: boolean; pickInstruments: boolean; prefill?: MapPrefill | undefined }) {
  const [creating, setCreating] = useState(!!prefill && canManage);
  const [deactivating, setDeactivating] = useState<IdMap>();
  const act = useSetupAction();
  const where = new Map(materials.flatMap((m) => m.levels.flatMap((l) => (l.lots ?? []).map((x) => [x.id, `${m.code} / ${l.display_name} / ${x.lot_no}`] as const))));

  const columns: ColumnDef<IdMap>[] = [
    { id: 'instrument', header: 'Instrument', isRowHeader: true, cell: (r) => r.instrument_label ?? r.instrument_id },
    { id: 'control', header: 'Control id (raw)', cell: (r) => r.control_id_raw },
    { id: 'lot', header: 'Lot (raw)', cell: (r) => r.control_lot_raw ?? 'Any lot' },
    { id: 'mapped', header: 'Material / Level / Lot', cell: (r) => where.get(r.lot_id) ?? '—' },
    { id: 'active', header: 'Active', cell: (r) => <StatusChip kind="generic" status={r.is_active ? 'active' : 'inactive'} label={r.is_active ? 'Active' : 'Inactive'} tone={r.is_active ? 'success' : 'neutral'} /> },
    ...(canManage ? [{ id: 'actions', header: 'Actions', cell: (r: IdMap) => (r.is_active ? <Button size="sm" variant="ghost" onPress={() => { act.reset(); setDeactivating(r); }}>Deactivate</Button> : null) }] : []),
  ];

  return (
    <SetupShell active="maps" actions={canManage ? <Button variant="primary" onPress={() => setCreating(true)}>New map</Button> : undefined}>
      <DataTable<IdMap> columns={columns} rows={rows} getRowId={(r) => r.id} density="compact" caption="Control ID maps" emptyState={{ title: 'No control-ID maps.' }} />
      {creating ? <NewMapDialog materials={materials} pickInstruments={pickInstruments} prefill={prefill} onClose={() => setCreating(false)} /> : null}
      <ConfirmDialog
        title="Deactivate control map" isOpen={!!deactivating} tone="danger" confirmLabel="Deactivate" onCancel={() => setDeactivating(undefined)}
        body={<><p>{`QC values with control id ${deactivating?.control_id_raw ?? ''} will no longer be assigned through this map.`}</p><FormMessage text={act.general} /></>}
        onConfirm={async () => {
          const r = deactivating;
          if (r) await act.run(`deactivate|${r.id}|${r.version}`, (k) => deactivateMapAction(r.id, r.version, k), { ok: 'Map deactivated', onOk: () => setDeactivating(undefined) });
        }}
      />
    </SetupShell>
  );
}

function NewMapDialog({ materials, pickInstruments, prefill, onClose }: { materials: Material[]; pickInstruments: boolean; prefill: MapPrefill | undefined; onClose: () => void }) {
  const act = useSetupAction();
  const [instrument, setInstrument] = useState<Picked | undefined>(prefill?.instrument_id ? { id: prefill.instrument_id, label: prefill.instrument_id } : undefined);
  const [controlId, setControlId] = useState(prefill?.control_id ?? '');
  const [lotRaw, setLotRaw] = useState(prefill?.control_lot ?? '');
  const [lot, setLot] = useState<string>();
  const lots = lotOptions(materials);

  const submit = async () => {
    const e = validateMap({ instrument_id: instrument?.id, control_id_raw: controlId, control_lot_raw: lotRaw, lot_id: lot });
    act.setErrors(e);
    if (Object.keys(e).length || !instrument || !lot) return;
    // raw values go out exactly as typed (they must equal what the analyser sends); an empty "lot as sent" means any lot, so it is omitted
    const input = { instrument_id: instrument.id, control_id_raw: controlId, ...(lotRaw ? { control_lot_raw: lotRaw } : {}), lot_id: lot };
    await act.run(JSON.stringify(input), (k) => createMapAction(input, k), {
      ok: 'Map created', onOk: onClose, hints: { duplicate: 'control_id', expired: { field: 'lot', text: 'This lot has expired.' }, pointer: (p) => POINTERS[p] },
    });
  };

  return (
    <FormDialog title="New map" submitLabel="Create" onClose={onClose} onSubmit={submit} general={act.general}>
      <InstrumentPicker enabled={pickInstruments} value={instrument} onChange={setInstrument} error={act.errors['instrument']} />
      <TextField label="Control id" name="control_id" isRequired maxLength={64} description="Exactly as the analyser sends it, e.g. QC-L2" value={controlId} onChange={setControlId} {...err(act.errors['control_id'])} />
      <TextField label="Lot as sent" name="control_lot" maxLength={64} description="Leave empty to match any lot" value={lotRaw} onChange={setLotRaw} {...err(act.errors['control_lot'])} />
      <Select<string> label="Lot" name="lot" options={lots} {...(lot ? { value: lot } : {})} onChange={setLot} {...err(act.errors['lot'])} />
    </FormDialog>
  );
}
