'use client';
// QC holds tab (04-UI-UX §3.13; 02-TRD §5.7 #45-#46; 07-SECURITY S-16): holds are created by the QC module (quality.qc_run.rejected.v1), this tab lists them and releases one with a comment
// (lab.qc_hold.release; a privileged session below aal2 gets auth.mfa_required -> re-authentication hint). The API enforces the permission — the UI only hides the button.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { listQcHoldsAction, releaseQcHoldAction } from '../../server/qc.actions';
import type { QcHold, QcHoldStatus } from '../../server/qc.types';
import { NativeSelect } from '../NativeSelect';
import { call, utc } from '../shared';
import { AlertText, errText, Field, ShortId } from './common';

const STATUS_OPTIONS = [{ value: 'active', label: 'Active' }, { value: 'released', label: 'Released' }] as const;

export function QcHoldsTab({ canRelease }: { canRelease: boolean }) {
  const [status, setStatus] = useState<QcHoldStatus>('active');
  const [rows, setRows] = useState<QcHold[] | null>(null);
  const [err, setErr] = useState('');
  const [target, setTarget] = useState<QcHold | null>(null);
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async (s: QcHoldStatus) => {
    const r = await call(listQcHoldsAction(s));
    if (r.ok) { setRows(r.data); setErr(''); } else { setRows((x) => x ?? []); setErr(errText(r)); }
  }, []);
  useEffect(() => { void load(status); }, [load, status]);

  const close = () => { setTarget(null); setMsg(''); };
  async function release() {
    if (busyRef.current || !target) return;
    if (comment.trim() === '') { setMsg('Enter a comment (1 to 500 characters).'); return; }
    busyRef.current = true; setBusy(true); setMsg('');
    const r = await call(releaseQcHoldAction(target.id, comment));
    busyRef.current = false; setBusy(false);
    if (r.ok) { close(); await load(status); return; }
    setMsg(errText(r));
  }

  return (
    <div>
      <p>Holds are created by the QC module.</p>
      <NativeSelect label="Status" value={status} placeholder={null} onChange={(v) => { setRows(null); setStatus(v as QcHoldStatus); }} options={STATUS_OPTIONS} />
      {target ? null : <AlertText text={err} />}
      {rows === null ? <p role="status">Loading…</p> : rows.length === 0 ? <p>No QC holds.</p> : (
        <table className="lims-table">
          <thead><tr>{['Instrument', 'Analyte', 'Status', 'Held at', 'Released at', 'Comment'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.id}>
                <td><ShortId value={h.instrument_id} /></td><td><ShortId value={h.analyte_id} /></td>
                <td><span>{h.status === 'active' ? 'Active' : 'Released'}</span></td>
                <td>{utc(h.held_at)}</td><td>{utc(h.released_at)}</td>
                <td>
                  {h.release_comment ?? null}
                  {canRelease && h.status === 'active' ? <Button variant="secondary" size="sm" onPress={() => { setComment(''); setMsg(''); setTarget(h); }}>Release</Button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        title="Release QC hold"
        isOpen={target !== null}
        onClose={close}
        footer={<><Button variant="ghost" onPress={close}>Cancel</Button><Button variant="primary" isDisabled={busy} onPress={() => void release()}>Release hold</Button></>}
      >
        <AlertText text={msg} />
        <Field label="Comment">
          {(p) => <textarea {...p} className="lims-input" rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />}
        </Field>
      </Dialog>
    </div>
  );
}
