'use client';
// 04-UI-UX §4.7 Coded lists tab (K11/K12; AC-14.3): Select of the list (Diagnoses, Cytology adequacy, Cancellation reasons; change/amendment reasons are C5) + table Code · Display ·
// System · Version · Active + Drawer (Code create-only, Display, System default "local", System version, Sort order, Active). Deactivated codes stay listed with the word "Inactive"
// (AC-14.3). Save: PUT /coded-sets/{set}/values/{code} with If-Match = the row version ("0" creates). Notice on Diagnoses: no external code sets are included (anatomic.config.codes_notice).
// LD-140 (2026-11-13, binding): kit components only; [Add code] is the page's one primary button.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { saveCodedValueAction } from '../../server/actions.config';
import type { CodedRow, CodedSet } from '../../server/config.types';
import { FormDialog } from '../material/FormDialog';
import { ActiveChip, cfgText, MasterList, MfaDialog } from './config-shared';

const SETS: readonly { value: CodedSet; label: string }[] = [{ value: 'diagnoses', label: 'Diagnoses' }, { value: 'cytology_adequacy', label: 'Cytology adequacy' }, { value: 'cancel_reasons', label: 'Cancellation reasons' }];
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function CodedListsTab({ set, rows }: { set: CodedSet; rows: readonly CodedRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<CodedRow | 'new'>();
  const [mfa, setMfa] = useState(false);
  const label = SETS.find((s) => s.value === set)?.label ?? set;
  return (
    <>
      <Select label="List" name="coded_set" options={SETS} value={set} onChange={(v) => router.push(`/anatomic/config?tab=coded-lists&set=${v}`)} />
      {set === 'diagnoses' ? <p className="lims-description">Add only codes your lab is licensed to use. No external code sets are included.</p> : null}
      <MasterList empty={rows.length === 0} title={`No ${label.toLowerCase()} codes yet.`} addLabel="Add code" onAdd={() => setEditing('new')}>
        <DataTable
          caption={label}
          density="compact"
          rows={rows}
          getRowId={(r) => r.code}
          emptyState={{ title: 'No codes' }}
          columns={[
            { id: 'code', header: 'Code', isRowHeader: true, cell: (r) => <span className="lims-mono">{r.code}</span> },
            { id: 'display', header: 'Display', cell: (r) => r.display },
            { id: 'system', header: 'System', hideBelow: 'md', cell: (r) => r.system },
            { id: 'version', header: 'Version', hideBelow: 'md', cell: (r) => r.system_version ?? '—' },
            { id: 'active', header: 'Active', cell: (r) => <ActiveChip active={r.is_active} /> },
            { id: 'edit', header: 'Actions', cell: (r) => <Button size="sm" variant="ghost" onPress={() => setEditing(r)}>{`Edit ${r.code}`}</Button> },
          ]}
        />
      </MasterList>
      {editing ? <CodeDrawer set={set} row={editing === 'new' ? undefined : editing} nextOrder={Math.min(9999, Math.max(0, ...rows.map((r) => r.sort_order)) + 1)} onClose={() => setEditing(undefined)} onMfa={() => { setEditing(undefined); setMfa(true); }} /> : null}
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}

function CodeDrawer({ set, row, nextOrder, onClose, onMfa }: { set: CodedSet; row: CodedRow | undefined; nextOrder: number; onClose: () => void; onMfa: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState(row?.code ?? '');
  const [display, setDisplay] = useState(row?.display ?? '');
  const [system, setSystem] = useState(row?.system ?? 'local');
  const [sysVersion, setSysVersion] = useState(row?.system_version ?? '');
  const [order, setOrder] = useState<number | undefined>(row?.sort_order ?? nextOrder);
  const [active, setActive] = useState(row?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  return (
    <FormDialog
      as="drawer"
      title={row ? 'Edit code' : 'Add code'}
      submitLabel="Save"
      describe={cfgText}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!row && !CODE.test(code)) {
          setCodeError('Use letters, digits and . _ : - only, 64 at most.');
          return undefined;
        }
        setCodeError(undefined);
        if (order === undefined) return undefined;
        const r = await saveCodedValueAction(set, code, row?.version ?? 0, { display, system, ...(sysVersion ? { system_version: sysVersion } : {}), sort_order: order, is_active: active });
        if (!r.ok) return r;
        toast.show({ tone: 'success', title: 'Saved' });
        onClose();
        router.refresh();
        return undefined;
      }}
    >
      <TextField label="Code" name="code" isRequired maxLength={64} value={code} onChange={setCode} {...(row ? { isReadOnly: true } : {})} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Display" name="display" isRequired maxLength={300} value={display} onChange={setDisplay} />
      <TextField label="System" name="system" isRequired maxLength={32} value={system} onChange={setSystem} />
      <TextField label="System version" name="system_version" maxLength={32} value={sysVersion} onChange={setSysVersion} />
      <IntegerField label="Sort order" name="sort_order" isRequired min={0} max={9999} {...(order !== undefined ? { value: order } : {})} onChange={setOrder} />
      {row ? <Switch label="Active" name="is_active" isSelected={active} onChange={setActive} /> : null}
    </FormDialog>
  );
}
