'use client';
// AD-14 LIMS provider support access: pending requests (Approve / Deny with note), active sessions (End access), history.
// Reason / ticket text from the platform is rendered as text only (REQ-SEC-088). Decisions need identity.settings.manage.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { supportAction } from '../actions';
import { Grid, Time } from '../Grid';
import { Alert, Field, useFailure } from '../ui';
import { copyFor, fmt } from '../lib';

export interface SupportSession { support_session_id: string; platform_staff_display_name: string; scope: string; reason_text: string; ticket_ref: string; duration_minutes: number; status: string; requested_at: string; started_at?: string; expires_at?: string; ended_at?: string; end_reason?: string; version: number }
const STATUS: Record<string, string> = { requested: 'Requested', approved: 'Approved', denied: 'Denied', active: 'Active', ended: 'Ended', expired: 'Expired', revoked: 'Ended by your lab' };

export function SupportAccess({ sessions, canDecide }: { sessions: SupportSession[]; canDecide: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState(sessions);
  const [deny, setDeny] = useState<SupportSession | null>(null);
  const [end, setEnd] = useState<SupportSession | null>(null);
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState<string>();
  const [dlgErr, setDlgErr] = useState<string | null>(null);
  const failure = useFailure();
  const update = (s: SupportSession, data: unknown) => setRows((xs) => xs.map((x) => (x.support_session_id === s.support_session_id ? { ...x, ...(data as Partial<SupportSession>) } : x)));
  const approve = async (s: SupportSession) => {
    failure.clear();
    const r = await supportAction(s.support_session_id, 'approve', s.version);
    if (!r.ok) { failure.set(r); return; }
    update(s, { status: 'approved', ...(r.data as object) });
    toast.show({ tone: 'success', title: 'Support access approved.' });
  };
  const card = (s: SupportSession, actions: React.ReactNode) => (
    <article key={s.support_session_id} className="lims-card">
      <h3>{s.platform_staff_display_name}</h3>
      <dl className="lims-dl">
        <dt>Reason</dt><dd>{s.reason_text}</dd>
        <dt>Ticket</dt><dd>{s.ticket_ref}</dd>
        <dt>Scope</dt><dd>{s.scope === 'admin' ? 'Admin' : 'Read only'}</dd>
        <dt>Duration</dt><dd>{s.duration_minutes} min</dd>
        {s.expires_at ? <><dt>Until</dt><dd>{fmt(s.expires_at)}</dd></> : null}
      </dl>
      {canDecide ? actions : null}
    </article>
  );
  const pending = rows.filter((s) => s.status === 'requested');
  const live = rows.filter((s) => s.status === 'active' || s.status === 'approved');
  const past = rows.filter((s) => !['requested', 'active', 'approved'].includes(s.status));
  return (
    <main className="lims-page">
      <header className="lims-page-header"><h1>Support access</h1></header>
      {failure.banner}
      <section aria-labelledby="sa-pending">
        <h2 id="sa-pending">Pending requests</h2>
        {pending.length ? pending.map((s) => card(s, (
          <>
            <Button variant="primary" onPress={() => void approve(s)}>Approve</Button>
            <Button onPress={() => { setNote(''); setNoteErr(undefined); setDlgErr(null); setDeny(s); }}>Deny</Button>
          </>
        ))) : <p>No pending requests.</p>}
      </section>
      <section aria-labelledby="sa-active">
        <h2 id="sa-active">Active</h2>
        {live.length ? live.map((s) => card(s, s.status === 'active'
          ? <Button variant="danger" onPress={() => { setDlgErr(null); setEnd(s); }}>End access</Button>
          : <p>Approved — waiting for the LIMS provider to start the session.</p>)) : <p>No active support access.</p>}
      </section>
      <section aria-labelledby="sa-history">
        <h2 id="sa-history">History</h2>
        <Grid label="History" columns={['Requested', 'Staff', 'Ticket', 'Status', 'Ended']}
          rows={past.map((s) => ({ key: s.support_session_id, cells: [<Time key="t" iso={s.requested_at} label={fmt(s.requested_at)} />, s.platform_staff_display_name, s.ticket_ref, STATUS[s.status] ?? s.status, fmt(s.ended_at)] }))} />
      </section>
      <ConfirmDialog title="Deny support access?" confirmLabel="Deny" tone="danger" isOpen={deny !== null} onCancel={() => setDeny(null)}
        body={<>{dlgErr ? <Alert text={dlgErr} /> : null}<Field label="Note to the LIMS provider" multiline value={note} onChange={setNote} error={noteErr} /></>}
        onConfirm={async () => {
          if (!deny) return;
          if (!note.trim() || note.length > 500) { setNoteErr('Enter a note (up to 500 characters)'); return; }
          const r = await supportAction(deny.support_session_id, 'deny', deny.version, note.trim());
          if (!r.ok) { setDlgErr(copyFor(r.code)); return; }
          update(deny, { status: 'denied', ...(r.data as object) });
          setDeny(null);
          toast.show({ tone: 'success', title: 'Support access denied.' });
        }} />
      <ConfirmDialog title="End support access?" confirmLabel="End access" tone="danger" isOpen={end !== null} onCancel={() => setEnd(null)}
        body={<>{dlgErr ? <Alert text={dlgErr} /> : null}<p>The LIMS provider staff member is logged out of your lab immediately.</p></>}
        onConfirm={async () => {
          if (!end) return;
          const r = await supportAction(end.support_session_id, 'revoke', end.version);
          if (!r.ok) { setDlgErr(copyFor(r.code)); return; }
          update(end, { status: 'revoked', ...(r.data as object) });
          setEnd(null);
          toast.show({ tone: 'success', title: 'Support access ended.' });
        }} />
      {failure.dialogs}
    </main>
  );
}
