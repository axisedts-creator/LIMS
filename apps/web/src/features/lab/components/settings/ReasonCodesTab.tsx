'use client';
// Reason codes tab (04-UI-UX §3.13; 02-TRD §5.8 #53-#54): one of the four coded sets; tenant rows shadow global rows of the same code. Add code / override a GLOBAL code = PUT without If-Match.
// SPEC GAP (CR-C5-T29-001, .orchestra/cr/C5.T-29.md): LabCodeDto has no `version`, so an existing TENANT row cannot be edited from here (#54 needs its If-Match) — only global rows offer Edit.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { useToast } from '@lims/ui/components/Toast';
import { listCodedSetAction, upsertCodeAction } from '../../server/config.actions';
import { CODED_SETS, type CodedSetName, type LabCode } from '../../server/config.types';
import { NativeSelect } from '../NativeSelect';
import { call } from '../shared';
import { AlertText, CheckInput, errText, isStale, TextInput } from './common';

const SET_LABEL: Record<CodedSetName, string> = { rejection_reasons: 'rejection_reasons', return_reasons: 'return_reasons', amendment_reasons: 'amendment_reasons', exception_discard_reasons: 'exception_discard_reasons' };
type Dlg = { kind: 'add' } | { kind: 'edit'; row: LabCode } | null;
interface CodeForm { code: string; display: string; order: string; active: boolean }
type CodeErrors = Partial<Record<'code' | 'display' | 'order', string>>;

export function ReasonCodesTab({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [set, setSet] = useState<CodedSetName>('rejection_reasons');
  const [rows, setRows] = useState<LabCode[] | null>(null);
  const [err, setErr] = useState('');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [f, setF] = useState<CodeForm>({ code: '', display: '', order: '0', active: true });
  const [errs, setErrs] = useState<CodeErrors>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async (s: CodedSetName) => {
    const r = await call(listCodedSetAction(s));
    if (r.ok) { setRows(r.data); setErr(''); } else { setRows((x) => x ?? []); setErr(errText(r)); }
  }, []);
  useEffect(() => { void load(set); }, [load, set]);

  const close = () => { setDlg(null); setErrs({}); };
  const open = (d: Dlg) => {
    setErr(''); setErrs({});
    setF(d?.kind === 'edit' ? { code: d.row.code, display: d.row.display, order: String(d.row.sort_order), active: d.row.is_active } : { code: '', display: '', order: '0', active: true });
    setDlg(d);
  };

  async function save() {
    if (busyRef.current || !dlg) return;
    const e: CodeErrors = {};
    const code = dlg.kind === 'edit' ? dlg.row.code : f.code;
    if (!/^[a-z0-9_]{1,64}$/.test(code)) e.code = 'Use lowercase letters, digits and underscores only (1 to 64 characters).';
    if (f.display.trim() === '' || f.display.length > 120) e.display = 'Display is required (1 to 120 characters).';
    if (!/^[0-9]{1,5}$/.test(f.order.trim()) || Number(f.order) > 10000) e.order = 'Order must be a whole number from 0 to 10000.';
    setErrs(e);
    if (Object.keys(e).length) return;
    busyRef.current = true; setBusy(true); setErr('');
    const r = await call(upsertCodeAction(set, code, { display: f.display, sort_order: Number(f.order), is_active: f.active }));
    busyRef.current = false; setBusy(false);
    if (r.ok) { close(); toast.show({ tone: 'success', title: 'Code saved' }); return load(set); }
    setErr(errText(r));
    if (isStale(r)) { close(); await load(set); }
  }

  if (rows === null) return <p role="status">Loading…</p>;
  return (
    <div>
      <NativeSelect label="Code set" value={set} placeholder={null} onChange={(v) => { setRows(null); setSet(v as CodedSetName); }} options={CODED_SETS.map((s) => ({ value: s, label: SET_LABEL[s] }))} />
      {dlg ? null : <AlertText text={err} />}
      {canManage ? <Button variant="primary" onPress={() => open({ kind: 'add' })}>Add code</Button> : null}
      <table className="lims-table">
        <thead><tr><th scope="col">Code</th><th scope="col">Display</th><th scope="col">Order</th><th scope="col">Active</th><th scope="col">Source</th>{canManage ? <th scope="col">Actions</th> : null}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code}>
              <td>{r.code}</td><td>{r.display}</td><td>{r.sort_order}</td><td><span>{r.is_active ? 'Active' : 'Inactive'}</span></td><td><span>{r.source === 'global' ? 'Global' : 'Tenant'}</span></td>
              {canManage ? <td>{r.source === 'global' ? <Button variant="secondary" size="sm" onPress={() => open({ kind: 'edit', row: r })}>Edit</Button> : null}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>

      <Dialog
        title={dlg?.kind === 'edit' ? 'Edit code' : 'Add code'}
        isOpen={dlg !== null}
        onClose={close}
        footer={<><Button variant="ghost" onPress={close}>Cancel</Button><Button variant="primary" isDisabled={busy} onPress={() => void save()}>Save</Button></>}
      >
        <AlertText text={err} />
        {dlg?.kind === 'add' ? <TextInput label="Code" value={f.code} onChange={(v) => setF({ ...f, code: v })} error={errs.code} /> : null}
        <TextInput label="Display" value={f.display} onChange={(v) => setF({ ...f, display: v })} error={errs.display} />
        <TextInput label="Order" type="number" value={f.order} onChange={(v) => setF({ ...f, order: v })} error={errs.order} />
        <CheckInput label="Active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      </Dialog>
    </div>
  );
}
