'use client';
// PL-7 Platform staff (07-SECURITY E-6, P-7; AC-E6): staff table, invite dialog with CIDR chips, sessions tab with [Log out].
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { inviteStaffAction, listPlatformSessionsAction, revokePlatformSessionAction } from './actions';
import { EMAIL_RE, MAX_CIDRS, errorText, isCidr, roleLabel, type PlatformSession, type Result, type StaffMember } from './shared';
import { Alert, SelectInput, TextInput, fmtDateTime, newKey, useSingleFlight } from './ui';

const COLUMNS: readonly ColumnDef<StaffMember>[] = [
  { id: 'name', header: 'Name', isRowHeader: true, cell: (s) => s.display_name },
  { id: 'email', header: 'Email', cell: (s) => s.email_masked },
  { id: 'role', header: 'Role', cell: (s) => roleLabel(s.role_code) },
  { id: 'cidrs', header: 'Allowed networks', cell: (s) => (s.allowed_cidrs.length ? s.allowed_cidrs.join(', ') : 'Any network') },
  // LD-114: PlatformStaff has no MFA field; the column shows a dash
  { id: 'mfa', header: 'MFA', cell: () => '—' },
  { id: 'status', header: 'Status', cell: (s) => <StatusChip kind="generic" status={s.is_active ? 'active' : 'inactive'} tone={s.is_active ? 'success' : 'neutral'} label={s.is_active ? 'Active' : 'Inactive'} /> },
];

export function StaffConsole({ staff }: { staff: readonly StaffMember[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState('staff');
  const [inviting, setInviting] = useState(false);
  return (
    <>
      <Button variant="primary" onPress={() => setInviting(true)}>Invite staff member</Button>
      <Tabs items={[{ id: 'staff', label: 'Staff' }, { id: 'sessions', label: 'Sessions' }]} selectedId={tab} onChange={setTab} aria-label="Platform staff sections">
        {tab === 'staff'
          ? <DataTable caption="Platform staff" columns={COLUMNS} rows={staff} getRowId={(s) => s.platform_staff_id} emptyState={{ title: 'No platform staff yet' }} />
          : <SessionsTab />}
      </Tabs>
      {inviting ? (
        <InviteDialog onClose={() => setInviting(false)}
          onInvited={() => { setInviting(false); toast.show({ tone: 'success', title: 'Invitation sent' }); router.refresh(); }} />
      ) : null}
    </>
  );
}

function SessionsTab() {
  const toast = useToast();
  const [state, setState] = useState<Result<{ data: PlatformSession[] }>>();
  const [confirm, setConfirm] = useState<PlatformSession>();
  const [error, setError] = useState<string>();
  const { run, pending } = useSingleFlight();
  useEffect(() => {
    let live = true;
    void listPlatformSessionsAction().then((r) => { if (live) setState(r); });
    return () => { live = false; };
  }, []);
  if (!state) return <p role="status">Loading sessions…</p>;
  if (!state.ok) return <ErrorState title="Could not load sessions" {...(state.requestId ? { requestId: state.requestId } : {})} />;
  const revoke = () => run(async () => {
    if (!confirm) return;
    const r = await revokePlatformSessionAction(confirm.session_id);
    const gone = confirm.session_id;
    setConfirm(undefined);
    if (!r.ok) return setError(errorText(r));
    setError(undefined);
    setState({ ok: true, data: { data: state.data.data.filter((s) => s.session_id !== gone) } });
    toast.show({ tone: 'success', title: 'Session logged out' });
  });
  return (
    <>
      <Alert>{error}</Alert>
      {state.data.data.length ? (
        <ul className="lims-list">
          {state.data.data.map((s) => (
            <li key={s.session_id}>
              {s.display_name ?? 'Platform staff'} · {s.client_ip_masked ?? ''} · {s.user_agent_family ?? ''} · last seen {fmtDateTime(s.last_seen_at ?? s.created_at)}{' '}
              <Button size="sm" variant="danger" onPress={() => setConfirm(s)}>Log out</Button>
            </li>
          ))}
        </ul>
      ) : <p>No active platform sessions.</p>}
      <Dialog title="Log out this session?" isOpen={!!confirm} onClose={() => setConfirm(undefined)} size="sm"
        footer={<Button variant="danger" isLoading={pending} onPress={() => void revoke()}>Log out</Button>}>
        <p>{confirm?.display_name ?? 'The staff member'} is signed out on that device.</p>
      </Dialog>
    </>
  );
}

function InviteDialog({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('platform_support');
  const [cidrs, setCidrs] = useState<string[]>([]);
  const [cidrText, setCidrText] = useState('');
  const [cidrError, setCidrError] = useState<string>();
  const [error, setError] = useState<string>();
  const key = useRef(newKey());
  const { run, pending } = useSingleFlight();

  const addCidr = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const v = cidrText.trim();
    if (!v) return;
    if (!isCidr(v)) return setCidrError(`"${v}" is not a network in CIDR form, e.g. 203.0.113.0/24 or 2001:db8::/32.`);
    if (cidrs.length >= MAX_CIDRS) return setCidrError(`At most ${MAX_CIDRS} networks.`);
    setCidrError(undefined);
    setCidrText('');
    setCidrs((p) => (p.includes(v) ? p : [...p, v]));
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    void run(async () => {
      if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email address.');
      if (!name.trim()) return setError('Enter the name.');
      setError(undefined);
      const r = await inviteStaffAction({ email: email.trim(), display_name: name.trim(), role_code: role, allowed_cidrs: cidrs }, key.current);
      key.current = newKey();
      if (!r.ok) return setError(`${errorText(r)}${r.requestId ? ` Reference: ${r.requestId}` : ''}`);
      onInvited();
    });
  };

  return (
    <Dialog title="Invite platform staff" isOpen onClose={onClose}
      footer={<Button variant="primary" isLoading={pending} onPress={() => submit()}>Send invitation</Button>}>
      <form onSubmit={submit} noValidate aria-label="Invite platform staff form">
        <TextInput label="Email" type="email" value={email} onChange={setEmail} maxLength={254} required />
        <TextInput label="Full name" value={name} onChange={setName} maxLength={120} required />
        <SelectInput label="Role" value={role} onChange={setRole} options={[{ value: 'platform_support', label: 'Support' }, { value: 'platform_superadmin', label: 'Superadmin' }]} />
        <TextInput label="Allowed networks (CIDR)" value={cidrText} onChange={setCidrText} maxLength={43} onKeyDown={addCidr} error={cidrError}
          hint="Press Enter after each network. Leave empty to allow any network." />
        <ul className="lims-chips" aria-label="Networks added">
          {cidrs.map((c) => (
            <li key={c} className="lims-chip">
              {c}{' '}
              <button type="button" className="lims-btn lims-btn-ghost lims-btn-sm" aria-label={`Remove ${c}`} onClick={() => setCidrs((p) => p.filter((x) => x !== c))}>×</button>
            </li>
          ))}
        </ul>
        <Alert>{error}</Alert>
      </form>
    </Dialog>
  );
}
