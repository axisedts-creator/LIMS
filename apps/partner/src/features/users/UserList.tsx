'use client';
// C13.T19 PU-1 Users (04-UI-UX PU-1; partner_admin only). Invite user (primary), row menu: Change role, Deactivate (coded reason), Reactivate, Resend invitation. E-mail is shown masked exactly as the API sends it.
// LD-140 (2026-11-13): @lims/ui components only; one primary action per page.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { TextField } from '@lims/ui/components/TextField';
import { Chip, Dt, ListScreen, type ListColumn, type Tone } from '../common/ui';
import type { PartnerUser } from '../common/types';
import { changeRoleAction, deactivateUserAction, inviteUserAction, reactivateUserAction, resendInvitationAction } from './actions';

export const USER_STATUS: Readonly<Record<string, readonly [Tone, string]>> = { invited: ['info', 'Invitation sent'], active: ['success', 'Active'], deactivated: ['neutral', 'Deactivated'] };
const DEACTIVATE_REASONS = [ // 05-SCHEMA §7 partner_user_deactivate_reasons
  { code: 'left_organisation', display: 'Left organisation' }, { code: 'role_changed', display: 'Role changed' }, { code: 'security_concern', display: 'Security concern' }, { code: 'other', display: 'Other' },
];
const ROLE_OPTIONS = [{ value: 'partner_member', label: 'Member' }, { value: 'partner_admin', label: 'Admin' }];
const ROLE_HELP = 'Admins can add users and doctors. Admins must use two-step sign-in.';
const actionsOf = (u: PartnerUser) =>
  u.status === 'deactivated' ? [{ id: 'reactivate', label: 'Reactivate' }]
    : [...(u.status === 'invited' ? [{ id: 'resend', label: 'Resend invitation' }] : [{ id: 'role', label: 'Change role' }]), { id: 'deactivate', label: 'Deactivate', isDanger: true }];

export function UserList({ rows, nextCursor }: { rows: PartnerUser[]; nextCursor?: string | undefined }) {
  const router = useRouter();
  const [dlg, setDlg] = useState<{ kind: 'invite' } | { kind: 'role' | 'deactivate'; user: PartnerUser } | null>(null);
  const [form, setForm] = useState({ email: '', display_name: '', partner_role: 'partner_member' });
  const [role, setRole] = useState('partner_member');
  const [msg, setMsg] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (ok: boolean, okText: string, failText = 'Could not complete the change. Try again in a moment.') => {
    setMsg({ tone: ok ? 'success' : 'danger', text: ok ? okText : failText });
    if (ok) router.refresh();
  };
  const onMenu = async (u: PartnerUser, id: string) => {
    if (id === 'role') { setRole(u.partner_role); setDlg({ kind: 'role', user: u }); }
    else if (id === 'deactivate') setDlg({ kind: 'deactivate', user: u });
    else if (id === 'reactivate') done((await reactivateUserAction(u.id, u.version ?? 0)).ok, 'User reactivated.');
    else if (id === 'resend') done((await resendInvitationAction(u.id, crypto.randomUUID())).ok, 'Invitation sent again.');
  };
  const invite = async () => {
    setBusy(true);
    const r = await inviteUserAction(form, crypto.randomUUID());
    setBusy(false);
    if (r.ok) { setDlg(null); setForm({ email: '', display_name: '', partner_role: 'partner_member' }); done(true, 'Invitation sent.'); }
    else setMsg({ tone: 'danger', text: r.code === 'identity.user_exists' ? 'A user with this e-mail already exists.' : 'Could not send the invitation.' });
  };
  const changeRole = async () => {
    if (dlg?.kind !== 'role') return;
    setBusy(true);
    const r = await changeRoleAction(dlg.user.id, dlg.user.version ?? 0, role);
    setBusy(false);
    setDlg(null);
    done(r.ok, 'Role changed.', r.ok ? '' : r.code === 'partners.last_partner_admin' ? 'An organisation needs at least one active administrator.' : r.code === 'partners.self_action_forbidden' ? 'You cannot change your own role.' : undefined);
  };

  const columns: ListColumn<PartnerUser>[] = [
    { id: 'name', header: 'Name', isRowHeader: true, cell: (u) => u.display_name },
    { id: 'email', header: 'Email', cell: (u) => u.email_masked },
    { id: 'role', header: 'Role', cell: (u) => <Badge tone={u.partner_role === 'partner_admin' ? 'info' : 'neutral'}>{u.partner_role === 'partner_admin' ? 'Admin' : 'Member'}</Badge> },
    { id: 'status', header: 'Status', cell: (u) => <Chip table={USER_STATUS} code={u.status} /> },
    { id: 'mfa', header: 'Two-step sign-in', cell: (u) => (u.mfa_enrolled ? 'Yes' : 'No') },
    { id: 'last', header: 'Last sign-in', hideBelow: 'md', cell: (u) => <Dt value={u.last_login_at} withTime /> },
  ];
  const empty = rows.length === 0;
  const openInvite = () => { setMsg(null); setDlg({ kind: 'invite' }); };

  return (
    <>
      <PageHeader title="Users" helpKey="partners.users" actions={empty ? null : <Button variant="primary" onPress={openInvite}>Invite user</Button>} />
      {msg ? <Banner tone={msg.tone} title={msg.text} /> : null}
      <ListScreen
        caption="Users"
        columns={columns}
        rows={rows}
        getRowId={(u) => u.id}
        nextCursor={nextCursor}
        rowActions={actionsOf}
        onRowActionMenu={(u, id) => void onMenu(u, id)}
        cardActions={(u) => actionsOf(u).map((a) => <Button key={a.id} size="sm" variant={'isDanger' in a ? 'danger' : 'secondary'} onPress={() => void onMenu(u, a.id)}>{a.label}</Button>)}
        empty={{ title: 'No users yet.', action: { label: 'Invite user', onPress: openInvite } }}
      />
      {dlg?.kind === 'invite' ? (
        <Dialog title="Invite user" isOpen onClose={() => setDlg(null)}>
          <Form onSubmit={invite}>
            <Stack gap={3}>
              <TextField label="Email" name="email" maxLength={254} inputMode="email" autoComplete="off" isRequired value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
              <TextField label="Name" name="display_name" maxLength={120} isRequired value={form.display_name} onChange={(v) => setForm({ ...form, display_name: v })} />
              <RadioGroup label="Role" name="partner_role" value={form.partner_role} onChange={(v) => setForm({ ...form, partner_role: v })} options={ROLE_OPTIONS} description={ROLE_HELP} />
              <div className="partner-card-actions">
                <Button type="submit" isLoading={busy}>Send invitation</Button>
                <Button variant="ghost" onPress={() => setDlg(null)}>Cancel</Button>
              </div>
            </Stack>
          </Form>
        </Dialog>
      ) : null}
      {dlg?.kind === 'role' ? (
        <Dialog title="Change role" isOpen onClose={() => setDlg(null)}>
          <Stack gap={3}>
            <RadioGroup label="Role" name="role" value={role} onChange={setRole} options={ROLE_OPTIONS} description={ROLE_HELP} />
            <div className="partner-card-actions">
              <Button isLoading={busy} onPress={() => void changeRole()}>Save role</Button>
              <Button variant="ghost" onPress={() => setDlg(null)}>Cancel</Button>
            </div>
          </Stack>
        </Dialog>
      ) : null}
      <ConfirmDialog
        title="Deactivate user" confirmLabel="Deactivate" tone="danger" isOpen={dlg?.kind === 'deactivate'} onCancel={() => setDlg(null)}
        body="This person will no longer be able to sign in."
        requireReason={{ codedSet: 'partner_user_deactivate_reasons', options: DEACTIVATE_REASONS }}
        onConfirm={async (r) => {
          if (dlg?.kind !== 'deactivate') return;
          const res = await deactivateUserAction(dlg.user.id, dlg.user.version ?? 0, r.reasonCode ?? '');
          setDlg(null);
          done(res.ok, 'User deactivated.', res.ok ? '' : res.code === 'partners.last_partner_admin' ? 'An organisation needs at least one active administrator.' : res.code === 'partners.self_action_forbidden' ? 'You cannot deactivate yourself.' : undefined);
        }}
      />
    </>
  );
}
