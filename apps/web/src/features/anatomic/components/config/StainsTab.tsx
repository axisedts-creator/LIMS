'use client';
// 04-UI-UX §4.7 Stains tab (K3/K4/K5; AC-14.2): table Code · Name · Kind · Add-on test · Active (inactive stains stay listed with the word "Inactive"); Drawer: Code (create only,
// ^[A-Z0-9_]{1,32}$), Name, Kind, Sort order, Active (edit only). Create: POST + Idempotency-Key; edit: PUT with If-Match = the stain's version. AC-14.2: the API refuses to deactivate
// the default routine stain (400 with its own message, shown in the drawer). Add-on test link: not editable here yet (open point: the catalog search path for the Combobox).
// LD-140 (2026-11-13, binding): kit components only; [Add stain] is the page's one primary button.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createStainAction, updateStainAction } from '../../server/actions.config';
import type { StainKind, StainRecord } from '../../server/config.types';
import { FormDialog } from '../material/FormDialog';
import { ActiveChip, cfgText, MasterList, MfaDialog, newKey } from './config-shared';

const KINDS: readonly { value: StainKind; label: string }[] = [{ value: 'routine', label: 'Routine' }, { value: 'special', label: 'Special' }, { value: 'ihc', label: 'IHC' }];
const KIND_LABEL: Record<StainKind, string> = { routine: 'Routine', special: 'Special', ihc: 'IHC' };
const CODE = /^[A-Z0-9_]{1,32}$/;

export function StainsTab({ stains }: { stains: readonly StainRecord[] }) {
  const [editing, setEditing] = useState<StainRecord | 'new'>();
  const [mfa, setMfa] = useState(false);
  return (
    <>
      <MasterList empty={stains.length === 0} title="No stains yet." addLabel="Add stain" onAdd={() => setEditing('new')}>
        <DataTable
          caption="Stains"
          density="compact"
          rows={stains}
          getRowId={(s) => s.id}
          emptyState={{ title: 'No stains yet.' }}
          columns={[
            { id: 'code', header: 'Code', isRowHeader: true, cell: (s) => <span className="lims-mono">{s.code}</span> },
            { id: 'name', header: 'Name', cell: (s) => s.display },
            { id: 'kind', header: 'Kind', cell: (s) => KIND_LABEL[s.kind] ?? s.kind },
            { id: 'addon', header: 'Add-on test', hideBelow: 'md', cell: (s) => (s.addon_test_id ? 'Linked' : '—') },
            { id: 'active', header: 'Active', cell: (s) => <ActiveChip active={s.is_active} /> },
            { id: 'edit', header: 'Actions', cell: (s) => <Button size="sm" variant="ghost" onPress={() => setEditing(s)}>{`Edit ${s.code}`}</Button> },
          ]}
        />
      </MasterList>
      {editing ? <StainDrawer stain={editing === 'new' ? undefined : editing} nextOrder={Math.min(9999, Math.max(0, ...stains.map((s) => s.sort_order)) + 1)} onClose={() => setEditing(undefined)} onMfa={() => { setEditing(undefined); setMfa(true); }} /> : null}
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}

function StainDrawer({ stain, nextOrder, onClose, onMfa }: { stain: StainRecord | undefined; nextOrder: number; onClose: () => void; onMfa: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState(stain?.code ?? '');
  const [display, setDisplay] = useState(stain?.display ?? '');
  const [kind, setKind] = useState<StainKind>(stain?.kind ?? 'routine');
  const [order, setOrder] = useState<number | undefined>(stain?.sort_order ?? nextOrder);
  const [active, setActive] = useState(stain?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  return (
    <FormDialog
      as="drawer"
      title={stain ? 'Edit stain' : 'Add stain'}
      submitLabel="Save"
      describe={cfgText}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!stain && !CODE.test(code)) {
          setCodeError('Use capital letters, digits and underscore, 32 at most.');
          return undefined;
        }
        setCodeError(undefined);
        if (order === undefined) return undefined;
        const r = stain
          ? await updateStainAction(stain.id, stain.version, { display, kind, sort_order: order, is_active: active, ...(stain.addon_test_id ? { addon_test_id: stain.addon_test_id } : {}) })
          : await createStainAction({ code, display, kind, sort_order: order }, newKey());
        if (!r.ok) return r;
        toast.show({ tone: 'success', title: 'Saved' });
        onClose();
        router.refresh();
        return undefined;
      }}
    >
      <TextField label="Code" name="code" isRequired maxLength={32} value={code} onChange={setCode} {...(stain ? { isReadOnly: true } : {})} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Name" name="display" isRequired maxLength={120} value={display} onChange={setDisplay} />
      <Select label="Kind" name="kind" options={KINDS} value={kind} onChange={setKind} />
      <IntegerField label="Sort order" name="sort_order" isRequired min={0} max={9999} {...(order !== undefined ? { value: order } : {})} onChange={setOrder} />
      {stain ? <Switch label="Active" name="is_active" isSelected={active} onChange={setActive} /> : null}
    </FormDialog>
  );
}
