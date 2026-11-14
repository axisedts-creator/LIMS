'use client';
// PL-5 Support sessions (AC-E4.1/E4.4/E4.6, 03-APP-FLOW §2.4 SP1..SP10). Admin scope is offered only to superadmin (07-SECURITY E-6).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { useToast } from '@lims/ui/components/Toast';
import { activateSupportSessionAction, endSupportSessionAction, openSupportSessionAction } from './actions';
import { errorText, isUuid, scopeLabel, supportStatusLabel, type SupportSession, type Tenant } from './shared';
import { Alert, SelectInput, TextAreaInput, TextInput, fmtDateTime, newKey, useProblemDialogs, useSingleFlight } from './ui';

type TenantRef = Pick<Tenant, 'tenant_id' | 'code' | 'display_name'>;

function remaining(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return '';
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'Expired';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min left`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60} min left` : `${Math.floor(h / 24)} d ${h % 24} h left`;
}

export function SupportSessions({ sessions, tenants, canOpen, canAdminScope }: {
  sessions: readonly SupportSession[]; tenants: readonly TenantRef[]; canOpen: boolean; canAdminScope: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const [openDialog, setOpenDialog] = useState(false);
  const [ending, setEnding] = useState<SupportSession>();
  const [error, setError] = useState<string>();
  const { run, pending } = useSingleFlight();
  const { handle, dialogs } = useProblemDialogs();
  const codeOf = (id: string) => tenants.find((t) => t.tenant_id === id)?.code ?? id;

  const active = sessions.filter((s) => s.status === 'active');
  const waiting = sessions.filter((s) => s.status === 'requested' || s.status === 'approved');
  const past = sessions.filter((s) => !active.includes(s) && !waiting.includes(s));

  const activate = (s: SupportSession) => run(async () => {
    const r = await activateSupportSessionAction(s.support_session_id, s.version);
    if (!r.ok) return setError(handle(r));
    setError(undefined);
    toast.show({ tone: 'success', title: `Support session for ${codeOf(s.tenant_id)} is active` });
    router.refresh();
  });
  const end = () => run(async () => {
    if (!ending) return;
    const r = await endSupportSessionAction(ending.support_session_id);
    setEnding(undefined);
    if (!r.ok) return setError(handle(r));
    setError(undefined);
    toast.show({ tone: 'success', title: 'Support session ended' });
    router.refresh();
  });

  return (
    <div className="lims-stack">
      {canOpen ? <Button variant="primary" onPress={() => setOpenDialog(true)}>Open support session</Button> : null}
      <Alert>{error}</Alert>
      <h2>Active</h2>
      {active.length ? active.map((s) => (
        <article key={s.support_session_id} className="lims-card" aria-label={`Support session ${codeOf(s.tenant_id)}`}>
          <p><strong>{codeOf(s.tenant_id)}</strong> · {scopeLabel(s.scope)} · {s.platform_staff_display_name}</p>
          <p>Reason: {s.reason_text}</p>
          <p>Ticket: {s.ticket_ref}</p>
          <p>Ends {fmtDateTime(s.expires_at)} · <span>{remaining(s.expires_at, now)}</span></p>
          <a className="lims-btn lims-btn-primary" href="/admin">Go to tenant admin</a>{' '}
          <Button variant="danger" onPress={() => setEnding(s)}>End</Button>
        </article>
      )) : <p>No active support session.</p>}
      <h2>Waiting</h2>
      {waiting.length ? (
        <ul className="lims-list">
          {waiting.map((s) => (
            <li key={s.support_session_id}>
              {codeOf(s.tenant_id)} · {scopeLabel(s.scope)} · {s.platform_staff_display_name} · {s.ticket_ref} · {supportStatusLabel(s.status)}{' '}
              {s.status === 'approved' ? <Button size="sm" onPress={() => void activate(s)} isDisabled={pending}>Activate</Button> : null}
            </li>
          ))}
        </ul>
      ) : <p>No requests waiting.</p>}
      <h2>History</h2>
      {past.length ? (
        <ul className="lims-list">
          {past.map((s) => (
            <li key={s.support_session_id}>
              {fmtDateTime(s.requested_at)} · {codeOf(s.tenant_id)} · {scopeLabel(s.scope)} · {s.platform_staff_display_name} · {s.ticket_ref} · {supportStatusLabel(s.status)}
            </li>
          ))}
        </ul>
      ) : <p>No past sessions.</p>}
      <Dialog title="End support session" isOpen={!!ending} onClose={() => setEnding(undefined)} size="sm"
        footer={<Button variant="danger" isLoading={pending} onPress={() => void end()}>End session</Button>}>
        <p>Access to {ending ? codeOf(ending.tenant_id) : ''} ends now.</p>
      </Dialog>
      {openDialog ? (
        <OpenDialog tenants={tenants} canAdminScope={canAdminScope} onClose={() => setOpenDialog(false)}
          onOpened={() => { setOpenDialog(false); toast.show({ tone: 'success', title: 'Support session requested' }); router.refresh(); }} />
      ) : null}
      {dialogs}
    </div>
  );
}

function OpenDialog({ tenants, canAdminScope, onClose, onOpened }: { tenants: readonly TenantRef[]; canAdminScope: boolean; onClose: () => void; onOpened: () => void }) {
  const [tenantId, setTenantId] = useState('');
  const [scope, setScope] = useState('read_only');
  const [reason, setReason] = useState('');
  const [ticket, setTicket] = useState('');
  const [duration, setDuration] = useState('30');
  const [error, setError] = useState<string>();
  const key = useRef(newKey());
  const { run, pending } = useSingleFlight();
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    void run(async () => {
      const d = Number(duration);
      if (!isUuid(tenantId)) return setError('Choose a tenant.');
      if (scope !== 'read_only' && !(scope === 'admin' && canAdminScope)) return setError('Choose a scope.');
      if (reason.trim().length < 10 || reason.length > 500) return setError('Reason: 10 to 500 characters, no patient details.');
      if (!ticket.trim() || ticket.length > 60) return setError('Enter the ticket reference (up to 60 characters).');
      if (!/^\d+$/.test(duration) || d < 5 || d > 60) return setError('Duration: 5 to 60 minutes.');
      setError(undefined);
      const r = await openSupportSessionAction({ tenant_id: tenantId, scope, reason_text: reason.trim(), ticket_ref: ticket.trim(), duration_minutes: d }, key.current);
      key.current = newKey();
      if (!r.ok) return setError(`${errorText(r)}${r.requestId ? ` Reference: ${r.requestId}` : ''}`);
      onOpened();
    });
  };
  return (
    <Dialog title="Open support session" isOpen onClose={onClose}
      footer={<Button variant="primary" isLoading={pending} onPress={() => submit()}>Open session</Button>}>
      <form onSubmit={submit} noValidate aria-label="Open support session form">
        <SelectInput label="Tenant" value={tenantId} onChange={setTenantId} placeholder="Choose a tenant"
          options={tenants.map((t) => ({ value: t.tenant_id, label: `${t.code} — ${t.display_name}` }))} />
        <SelectInput label="Scope" value={scope} onChange={setScope}
          options={[{ value: 'read_only', label: 'Read only' }, ...(canAdminScope ? [{ value: 'admin', label: 'Admin' }] : [])]} />
        <TextAreaInput label="Reason" value={reason} onChange={setReason} maxLength={500} hint="No patient details." required />
        <TextInput label="Ticket reference" value={ticket} onChange={setTicket} maxLength={60} required />
        <TextInput label="Duration (minutes)" type="number" value={duration} onChange={setDuration} min={5} max={60} required />
        <Alert>{error}</Alert>
      </form>
    </Dialog>
  );
}
