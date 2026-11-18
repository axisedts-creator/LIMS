'use client';
// LD-310 / T0D-REGSCREEN-2: the user's own registration drafts (listRegistrationDrafts / getRegistrationDraft / deleteRegistrationDraft, T0B-REGAPI-2).
// A dialog, not part of the page flow (one screen at 1366x768). The table header is always drawn, also when empty (founder rule 2026-11-17).
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { parseDraftPayload, type DraftPayload } from '../forms/draft';
import { deleteDraftAction, getDraftAction, getPatientSummaryAction, listDraftsAction } from '../server/actions';
import type { Centre, DraftRecordSummary, PatientSummary } from '../server/types';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
type PatientOf = (id: string) => Promise<PatientSummary | undefined>;
const patientOf: PatientOf = async (id) => { const r = await getPatientSummaryAction(id); return r.ok ? r.data : undefined; };

export function DraftsDialog({ centres, onClose, onOpen }: {
  centres: readonly Centre[]; onClose: () => void;
  /** Puts the draft on the form; false = it could not (the form is left as it was). */
  onOpen: (p: DraftPayload, draftId: string, patientOf: PatientOf) => Promise<boolean>;
}) {
  const [rows, setRows] = useState<DraftRecordSummary[]>();
  const [loadErr, setLoadErr] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setLoadErr(undefined);
    void listDraftsAction().then((r) => { if (!live) return; if (r.ok) setRows(r.data); else setLoadErr(r.title ?? 'Drafts could not load'); });
    return () => { live = false; };
  }, [nonce]);
  const drop = (id: string) => setRows((rs) => rs?.filter((x) => x.id !== id));
  const open = async (id: string) => {
    if (busy) return;
    setBusy(true); setMsg(undefined);
    try {
      const r = await getDraftAction(id);
      if (!r.ok) { setMsg(r.status === 404 ? 'This draft is no longer available (expired or removed)' : r.title ?? 'This draft could not be opened'); if (r.status === 404) drop(id); return; }
      const p = parseDraftPayload(r.data.payload);
      if (!p || !(await onOpen(p, id, patientOf))) setMsg('This draft could not be opened: it is not usable');
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    const r = await deleteDraftAction(id);
    if (r.ok || r.status === 404) drop(id); else setMsg(r.title ?? 'The draft could not be deleted');
  };
  const centre = (id: string) => centres.find((c) => c.id === id)?.name ?? '—';

  return (
    <Dialog title="Drafts" isOpen onClose={onClose} size="lg">
      <div role="status" aria-live="polite">{msg ? <p>{msg}</p> : null}</div>
      {loadErr ? <p>{loadErr} <Button variant="ghost" onPress={() => setNonce((n) => n + 1)}>Retry</Button></p> : null}
      <div className="lims-reg-drafts">
        <table aria-label="Saved drafts">
          <thead><tr><th scope="col">Saved</th><th scope="col">Laboratory</th><th scope="col">Expires</th><th scope="col"><VisuallyHidden>Actions</VisuallyHidden></th></tr></thead>
          <tbody>
            {rows?.length === 0 ? <tr><td colSpan={4}>No saved drafts</td></tr> : null}
            {(rows ?? []).map((d) => (
              <tr key={d.id}>
                <td>{when(d.updated_at)}</td><td>{centre(d.centre_id)}</td><td>{when(d.expires_at)}</td>
                <td><Button variant="ghost" onPress={() => void open(d.id)}>Open</Button> <Button variant="ghost" onPress={() => void remove(d.id)}>Delete</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
