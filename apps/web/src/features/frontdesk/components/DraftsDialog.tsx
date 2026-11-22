'use client';
// LD-310 / T0D-REGSCREEN-2: the user's own registration drafts (listRegistrationDrafts / getRegistrationDraft / deleteRegistrationDraft, T0B-REGAPI-2).
// A dialog, not part of the page flow (one screen at 1366x768). The table header is always drawn, also when empty (founder rule 2026-11-17).
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
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
  const columns: ColumnDef<DraftRecordSummary>[] = [
    { id: 'saved', header: 'Saved', cell: (d) => when(d.updated_at) },
    { id: 'centre', header: 'Laboratory', cell: (d) => centre(d.centre_id), isRowHeader: true },
    { id: 'expires', header: 'Expires', cell: (d) => when(d.expires_at) },
    { id: 'actions', header: 'Actions', cell: (d) => <><Button variant="ghost" onPress={() => void open(d.id)}>Open</Button> <Button variant="ghost" onPress={() => void remove(d.id)}>Delete</Button></> },
  ];

  return (
    <Dialog title="Drafts" isOpen onClose={onClose} size="lg">
      <div role="status" aria-live="polite">{msg ? <p>{msg}</p> : null}</div>
      {loadErr ? <p>{loadErr} <Button variant="ghost" onPress={() => setNonce((n) => n + 1)}>Retry</Button></p> : null}
      <div className="lims-reg-drafts">
        {/* T0D-UIX-4 (LD-442): kit DataTable; the header stays when there are no drafts. */}
        <DataTable
          caption="Saved drafts"
          columns={columns}
          rows={rows ?? []}
          getRowId={(d) => d.id}
          isLoading={rows === undefined && !loadErr}
          emptyState={{ title: 'No saved drafts' }}
        />
      </div>
    </Dialog>
  );
}
