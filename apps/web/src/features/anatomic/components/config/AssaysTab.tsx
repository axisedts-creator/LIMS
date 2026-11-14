'use client';
// 04-UI-UX §4.7 Assays tab (K8/K9/K10): table Code · Name · Targets · Active; editor Drawer (large): assay fields + nested targets (Code, Name, Quantitative, Unit code, Decimals, Active)
// and per-target result values (Code ^[a-z0-9_]{1,32}$, Display, Abnormal, Active). Saved codes are read-only and have no Remove button: they can only be deactivated (TRD §5.6).
// Create: POST + Idempotency-Key; edit: PUT of the WHOLE assay (no ids) with If-Match = the assay version. An assay needs at least one target and every target one value (AssayInput).
// LD-140 (2026-11-13, binding): kit components only; [Add assay] is the page's one primary button.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable } from '@lims/ui/components/DataTable';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createAssayAction, updateAssayAction } from '../../server/actions.config';
import type { AssayInput, AssayRecord, AssayTargetInput, AssayValueInput } from '../../server/config.types';
import { FormDialog } from '../material/FormDialog';
import { ActiveChip, cfgText, MasterList, MfaDialog, newKey } from './config-shared';

const UPPER = /^[A-Z0-9_]{1,32}$/;
const LOWER = /^[a-z0-9_]{1,32}$/;
/** A value / target as edited: `saved` codes are read-only. */
interface V extends AssayValueInput { saved: boolean }
interface T extends Omit<AssayTargetInput, 'result_values' | 'decimals'> { decimals?: number | undefined; saved: boolean; result_values: V[] }

const fromRecord = (a: AssayRecord): T[] =>
  a.targets.map((t) => ({
    code: t.code, display: t.display, allows_quantitative: t.allows_quantitative, ...(t.unit_code ? { unit_code: t.unit_code } : {}), ...(t.decimals !== undefined ? { decimals: t.decimals } : {}),
    sort_order: t.sort_order, is_active: t.is_active, saved: true,
    result_values: t.result_values.map((v) => ({ code: v.code, display: v.display, is_abnormal: v.is_abnormal, sort_order: v.sort_order, is_active: v.is_active, saved: true })),
  }));

export function AssaysTab({ assays }: { assays: readonly AssayRecord[] }) {
  const [editing, setEditing] = useState<AssayRecord | 'new'>();
  const [mfa, setMfa] = useState(false);
  return (
    <>
      <MasterList empty={assays.length === 0} title="No assays yet." addLabel="Add assay" onAdd={() => setEditing('new')}>
        <DataTable
          caption="Assays"
          density="compact"
          rows={assays}
          getRowId={(a) => a.id}
          emptyState={{ title: 'No assays yet.' }}
          columns={[
            { id: 'code', header: 'Code', isRowHeader: true, cell: (a) => <span className="lims-mono">{a.code}</span> },
            { id: 'name', header: 'Name', cell: (a) => a.display },
            { id: 'targets', header: 'Targets', align: 'end', cell: (a) => ` ${a.targets.length} ` }, // spaces: the count stays a separate word when the row is read as text
            { id: 'active', header: 'Active', cell: (a) => <ActiveChip active={a.is_active} /> },
            { id: 'edit', header: 'Actions', cell: (a) => <Button size="sm" variant="ghost" onPress={() => setEditing(a)}>{`Edit ${a.code}`}</Button> },
          ]}
        />
      </MasterList>
      {editing ? <AssayDrawer assay={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onMfa={() => { setEditing(undefined); setMfa(true); }} /> : null}
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}

function AssayDrawer({ assay, onClose, onMfa }: { assay: AssayRecord | undefined; onClose: () => void; onMfa: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState(assay?.code ?? '');
  const [display, setDisplay] = useState(assay?.display ?? '');
  const [method, setMethod] = useState(assay?.method_text_default ?? '');
  const [active, setActive] = useState(assay?.is_active ?? true);
  const [targets, setTargets] = useState<T[]>(assay ? fromRecord(assay) : []);
  const [tried, setTried] = useState(false);

  const setT = (i: number, patch: Partial<T>) => setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const setV = (i: number, k: number, patch: Partial<V>) => setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, result_values: t.result_values.map((v, m) => (m === k ? { ...v, ...patch } : v)) } : t)));
  const addTarget = () => setTargets((ts) => [...ts, { code: '', display: '', allows_quantitative: false, sort_order: Math.min(9999, ts.length + 1), is_active: true, saved: false, result_values: [] }]);
  const addValue = (i: number) => setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, result_values: [...t.result_values, { code: '', display: '', is_abnormal: false, sort_order: Math.min(9999, t.result_values.length + 1), is_active: true, saved: false }] } : t)));

  const dup = (codes: string[], c: string) => c !== '' && codes.filter((x) => x === c).length > 1;
  const problems = (): boolean =>
    (!assay && !UPPER.test(code)) || targets.length < 1 ||
    targets.some((t) => !UPPER.test(t.code) || !t.display || dup(targets.map((x) => x.code), t.code) || t.result_values.length < 1 || t.result_values.some((v) => !LOWER.test(v.code) || !v.display || dup(t.result_values.map((x) => x.code), v.code)));

  const build = (): AssayInput => ({
    code, display, ...(method ? { method_text_default: method } : {}), is_active: active,
    targets: targets.map((t) => ({
      code: t.code, display: t.display, allows_quantitative: t.allows_quantitative,
      ...(t.allows_quantitative && t.unit_code ? { unit_code: t.unit_code } : {}), ...(t.allows_quantitative && t.decimals !== undefined ? { decimals: t.decimals } : {}),
      sort_order: t.sort_order, is_active: t.is_active,
      result_values: t.result_values.map((v) => ({ code: v.code, display: v.display, is_abnormal: v.is_abnormal, sort_order: v.sort_order, is_active: v.is_active })),
    })),
  });

  const codeErr = (ok: boolean, text: string) => (tried && !ok ? { error: text } : {});
  return (
    <FormDialog
      as="drawer"
      width="lg"
      title={assay ? 'Edit assay' : 'Add assay'}
      submitLabel="Save"
      describe={cfgText}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        setTried(true);
        if (problems()) return undefined;
        const r = assay ? await updateAssayAction(assay.id, assay.version, build()) : await createAssayAction(build(), newKey());
        if (!r.ok) return r;
        toast.show({ tone: 'success', title: 'Saved' });
        onClose();
        router.refresh();
        return undefined;
      }}
    >
      <TextField label="Code" name="code" isRequired maxLength={32} value={code} onChange={setCode} {...(assay ? { isReadOnly: true } : {})} {...codeErr(!!assay || UPPER.test(code), 'Use capital letters, digits and underscore, 32 at most.')} />
      <TextField label="Name" name="display" isRequired maxLength={120} value={display} onChange={setDisplay} />
      <TextField label="Default method" name="method_text_default" maxLength={200} value={method} onChange={setMethod} />
      <Switch label="Active" name="is_active" isSelected={active} onChange={setActive} />
      <h3>Targets</h3>
      <p className="lims-description">Saved codes can&apos;t be deleted, only deactivated.</p>
      {tried && targets.length < 1 ? <p className="lims-error" role="alert">Add at least one target.</p> : null}
      {targets.map((t, i) => (
        <div key={i} data-target={t.code}>
          <TextField label="Target code" name={`target_code_${i}`} isRequired maxLength={32} value={t.code} onChange={(v) => setT(i, { code: v })} {...(t.saved ? { isReadOnly: true } : {})} {...codeErr(UPPER.test(t.code) && !dup(targets.map((x) => x.code), t.code), 'Use capital letters, digits and underscore, 32 at most, once per assay.')} />
          <TextField label="Target name" name={`target_display_${i}`} isRequired maxLength={120} value={t.display} onChange={(v) => setT(i, { display: v })} />
          <Switch label="Quantitative" name={`target_quant_${i}`} isSelected={t.allows_quantitative} onChange={(v) => setT(i, { allows_quantitative: v })} />
          {t.allows_quantitative ? (
            <>
              <TextField label="Unit code" name={`target_unit_${i}`} maxLength={32} value={t.unit_code ?? ''} onChange={(v) => setT(i, { unit_code: v })} />
              <IntegerField label="Decimals" name={`target_decimals_${i}`} min={0} max={6} {...(t.decimals !== undefined ? { value: t.decimals } : {})} onChange={(v) => setT(i, { decimals: v })} />
            </>
          ) : null}
          <Switch label="Active" name={`target_active_${i}`} isSelected={t.is_active} onChange={(v) => setT(i, { is_active: v })} />
          {tried && t.result_values.length < 1 ? <p className="lims-error" role="alert">Add at least one result value to this target.</p> : null}
          {t.result_values.map((v, k) => (
            <div key={k} data-value={v.code}>
              <TextField label="Value code" name={`value_code_${i}_${k}`} isRequired maxLength={32} value={v.code} onChange={(x) => setV(i, k, { code: x })} {...(v.saved ? { isReadOnly: true } : {})} {...codeErr(LOWER.test(v.code) && !dup(t.result_values.map((x) => x.code), v.code), 'Use lower case letters, digits and underscore, 32 at most, once per target.')} />
              <TextField label="Value display" name={`value_display_${i}_${k}`} isRequired maxLength={120} value={v.display} onChange={(x) => setV(i, k, { display: x })} />
              <Checkbox label="Abnormal" isSelected={v.is_abnormal} onChange={(x) => setV(i, k, { is_abnormal: x })} />
              <Switch label="Active" name={`value_active_${i}_${k}`} isSelected={v.is_active} onChange={(x) => setV(i, k, { is_active: x })} />
            </div>
          ))}
          <Button size="sm" iconStart="plus" onPress={() => addValue(i)}>Add value</Button>
        </div>
      ))}
      <Button iconStart="plus" onPress={addTarget}>Add target</Button>
    </FormDialog>
  );
}
