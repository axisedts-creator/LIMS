'use client';
// 04-UI-UX §2.6 Materials tab: list + right drawer (levels, lots) + dialogs for new material, add lot, deactivate. LD-140: @lims/ui only.
// helpKey of this screen is set by SetupShell (quality.setup_materials). Writes need quality.qc.manage (the server decides; the buttons are only hidden).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { addLotAction, createMaterialAction, deactivateMaterialAction } from './actions';
import { FormDialog, FormMessage, err, useSetupAction } from './fields';
import { SetupShell } from './SetupShell';
import type { Level, Material } from './types';
import { MSG, validateLot, validateMaterial } from './validate';

type Iso = DateTextProps['value'];
const ActiveChip = ({ on }: { on: boolean }) => <StatusChip kind="generic" status={on ? 'active' : 'inactive'} label={on ? 'Active' : 'Inactive'} tone={on ? 'success' : 'neutral'} />;

export function MaterialsView({ rows, showInactive, canManage }: { rows: Material[]; showInactive: boolean; canManage: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string>();
  const open = rows.find((m) => m.id === openId);

  const columns: ColumnDef<Material>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (m) => <Button variant="ghost" size="sm" onPress={() => setOpenId(m.id)}>{m.code}</Button> },
    { id: 'name', header: 'Name', cell: (m) => m.name },
    { id: 'manufacturer', header: 'Manufacturer', cell: (m) => m.manufacturer ?? '—' },
    { id: 'levels', header: 'Levels', align: 'end', cell: (m) => ` ${m.levels.length} ` }, // padded: the cell text stays a separate word when cells are read as one line
    {
      id: 'expiring', header: 'Lots expiring ≤ 30 days', align: 'end',
      cell: (m) => (m.lots_expiring_30d > 0 ? <StatusChip kind="generic" status="expiring" tone="warning" label={`${m.lots_expiring_30d} expiring`} /> : '0'),
    },
    { id: 'active', header: 'Active', cell: (m) => <ActiveChip on={m.is_active} /> },
  ];

  return (
    <SetupShell active="materials" actions={canManage ? <Button variant="primary" onPress={() => setCreating(true)}>New material</Button> : undefined}>
      <Switch label="Show inactive" isSelected={showInactive} onChange={(on) => router.push(`/quality/setup/materials${on ? '?is_active=false' : ''}`)} />
      <DataTable<Material> columns={columns} rows={rows} getRowId={(m) => m.id} density="compact" caption="Control materials" emptyState={{ title: 'No control materials yet.' }} />
      {creating ? <NewMaterialDialog onClose={() => setCreating(false)} /> : null}
      {open ? <MaterialDrawer material={open} canManage={canManage} onClose={() => setOpenId(undefined)} /> : null}
    </SetupShell>
  );
}

// ---------------------------------------------------------------- new material (#2)
interface Row { key: number; code: string; name: string; sort: number | undefined }
const ptr = (p: string) => {
  const m = /^\/levels\/(\d+)\/(level_code|display_name|sort_order)$/.exec(p);
  if (m) return `level.${m[1]}.${({ level_code: 'code', display_name: 'name', sort_order: 'sort' } as Record<string, string>)[m[2]!]}`;
  return ['code', 'name', 'manufacturer', 'matrix'].find((f) => p === `/${f}`);
};

function NewMaterialDialog({ onClose }: { onClose: () => void }) {
  const act = useSetupAction();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [matrix, setMatrix] = useState('');
  const [rows, setRows] = useState<Row[]>([{ key: 1, code: '1', name: 'Level 1', sort: 1 }, { key: 2, code: '2', name: 'Level 2', sort: 2 }]);
  const [next, setNext] = useState(3);
  const patch = (key: number, p: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const submit = async () => {
    const input = {
      code, name: name.trim(), ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}), ...(matrix.trim() ? { matrix: matrix.trim() } : {}),
      levels: rows.map((r) => ({ level_code: r.code, display_name: r.name.trim(), sort_order: r.sort ?? Number.NaN })),
    };
    const e = validateMaterial(input);
    act.setErrors(e);
    if (Object.keys(e).length) return;
    await act.run(JSON.stringify(input), (k) => createMaterialAction(input, k), { ok: 'Material created', hints: { duplicate: 'code', pointer: ptr }, onOk: onClose });
  };

  return (
    <FormDialog title="New material" submitLabel="Create" onClose={onClose} onSubmit={submit} general={act.general} size="lg">
      <TextField label="Code" name="code" isRequired maxLength={32} value={code} onChange={(v) => setCode(v.toUpperCase())} {...err(act.errors['code'])} />
      <TextField label="Name" name="name" isRequired maxLength={120} value={name} onChange={setName} {...err(act.errors['name'])} />
      <TextField label="Manufacturer" name="manufacturer" maxLength={120} value={manufacturer} onChange={setManufacturer} {...err(act.errors['manufacturer'])} />
      <TextField label="Matrix" name="matrix" maxLength={60} value={matrix} onChange={setMatrix} {...err(act.errors['matrix'])} />
      {rows.map((r, i) => (
        <div key={r.key}>
          <TextField label="Level code" name={`level_code_${r.key}`} isRequired maxLength={16} value={r.code} onChange={(v) => patch(r.key, { code: v })} {...err(act.errors[`level.${i}.code`])} />
          <TextField label="Level name" name={`level_name_${r.key}`} isRequired maxLength={60} value={r.name} onChange={(v) => patch(r.key, { name: v })} {...err(act.errors[`level.${i}.name`])} />
          <IntegerField label="Sort order" name={`sort_${r.key}`} min={0} max={99} {...(r.sort !== undefined ? { value: r.sort } : {})} onChange={(v) => patch(r.key, { sort: v })} {...err(act.errors[`level.${i}.sort`])} />
          <Button variant="ghost" size="sm" isDisabled={rows.length <= 1} onPress={() => setRows((x) => x.filter((y) => y.key !== r.key))}>Remove level</Button>
        </div>
      ))}
      <Button size="sm" isDisabled={rows.length >= 6} onPress={() => { setRows((x) => [...x, { key: next, code: String(x.length + 1), name: `Level ${x.length + 1}`, sort: x.length + 1 }]); setNext(next + 1); }}>Add level</Button>
      <FormMessage text={act.errors['levels']} />
    </FormDialog>
  );
}

// ---------------------------------------------------------------- drawer: levels and lots, deactivate (#5)
function MaterialDrawer({ material: m, canManage, onClose }: { material: Material; canManage: boolean; onClose: () => void }) {
  const act = useSetupAction();
  const [lotFor, setLotFor] = useState<Level>();
  const [confirm, setConfirm] = useState(false);
  const writable = canManage && m.is_active;
  return (
    <>
      <Drawer title={`${m.code} · ${m.name}`} isOpen onClose={onClose}>
        <DescriptionList items={[
          { term: 'Manufacturer', value: m.manufacturer ?? '—' }, { term: 'Matrix', value: m.matrix ?? '—' }, { term: 'Status', value: <ActiveChip on={m.is_active} /> },
        ]} />
        {m.levels.map((l) => (
          <section key={l.id} aria-label={`Level ${l.level_code}`}>
            <h3 className="lims-drawer-section-title">{`${l.display_name} (${l.level_code})`}</h3>
            {(l.lots ?? []).length ? (
              <ul>
                {(l.lots ?? []).map((x) => (
                  <li key={x.id}>
                    {`${x.lot_no} · expires `}<DateText value={x.expires_on as Iso} />{' '}
                    {x.is_expired ? <StatusChip kind="generic" status="expired" tone="danger" label="Expired" /> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="lims-description">No lots yet.</p>}
            {writable && l.is_active ? <Button size="sm" onPress={() => setLotFor(l)}>Add lot</Button> : null}
          </section>
        ))}
        {writable ? <Button variant="danger" onPress={() => { act.reset(); setConfirm(true); }}>Deactivate material</Button> : null}
      </Drawer>
      {lotFor ? <LotDialog level={lotFor} onClose={() => setLotFor(undefined)} /> : null}
      <ConfirmDialog
        title="Deactivate material" isOpen={confirm} tone="danger" confirmLabel="Deactivate" onCancel={() => setConfirm(false)}
        body={<><p>{`Deactivate ${m.code}? It stays readable, but no new lots, maps or plans can use it.`}</p><FormMessage text={act.general} /></>}
        onConfirm={async () => { await act.run(`deactivate|${m.id}|${m.version}`, (k) => deactivateMaterialAction(m.id, m.version, k), { ok: 'Material deactivated', onOk: () => setConfirm(false) }); }}
      />
    </>
  );
}

// ---------------------------------------------------------------- add lot (#8)
function LotDialog({ level, onClose }: { level: Level; onClose: () => void }) {
  const act = useSetupAction();
  const [lotNo, setLotNo] = useState('');
  const [expires, setExpires] = useState<IsoDate>();
  const submit = async () => {
    const e = validateLot({ lot_no: lotNo, expires_on: expires });
    act.setErrors(e);
    if (Object.keys(e).length) return;
    const input = { lot_no: lotNo, expires_on: String(expires) };
    await act.run(JSON.stringify(input), (k) => addLotAction(level.id, input, k), {
      ok: 'Lot added', hints: { duplicate: 'lot_no', expired: { field: 'expires_on', text: MSG.expired }, pointer: (p) => (p === '/lot_no' ? 'lot_no' : p === '/expires_on' ? 'expires_on' : undefined) }, onOk: onClose,
    });
  };
  return (
    <FormDialog title={`Add lot · ${level.display_name}`} size="sm" submitLabel="Save" onClose={onClose} onSubmit={submit} general={act.general}>
      <TextField label="Lot number" name="lot_no" isRequired maxLength={64} value={lotNo} onChange={setLotNo} {...err(act.errors['lot_no'])} />
      <DatePicker label="Expires on" name="expires_on" {...(expires ? { value: expires } : {})} onChange={setExpires} {...err(act.errors['expires_on'])} />
    </FormDialog>
  );
}
