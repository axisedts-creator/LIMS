'use client';
// SP-2 Partner detail (tabs Overview / Users / Manifests / Doctors) and SP-3 Partner users (04-UI-UX §4, US-01.5). Every tab loads on its own: a failing read
// shows a banner in that tab only. Suspended partners stay readable. Writes: SA5 suspend, SA6 reactivate, SA7 resync, SA9-SA12 users.
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { Menu } from '@lims/ui/components/Menu';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import {
  changePartnerUserRoleAction, deactivatePartnerUserAction, invitePartnerUserAction, reactivatePartnerAction, reactivatePartnerUserAction, resyncPartnerAction, suspendPartnerAction,
} from '../server/actions';
import type { ActionResult, ManifestSummary, Partner, PartnerUser, Referrer } from '../server/types';
import { Ad, Chip, DialogError, LoadFailed, Notice, REASONS, errorText, hasPerm } from './common';

type Role = PartnerUser['partner_role'];
const ROLES = [{ value: 'partner_admin', label: 'Administrator' }, { value: 'partner_member', label: 'Member' }] as const;
const roleLabel = (r: string) => (r === 'partner_admin' ? 'Administrator' : 'Member');
const RESYNC = [{ id: 'price_list', label: 'Price list' }, { id: 'statements', label: 'Statements' }, { id: 'tracking', label: 'Orders and tracking' }] as const;
const SUSPEND_REASON = REASONS.partner_suspend_reasons;

function InviteDialog({ partnerId, onClose, onDone }: { partnerId: string; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('partner_member');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (!/^[^@\s]+@[^@\s]+$/.test(email.trim()) || !name.trim()) return setError('Enter a valid email address and a name.');
    setBusy(true);
    setError(undefined);
    try {
      const r = await invitePartnerUserAction(partnerId, { email: email.trim(), display_name: name.trim(), partner_role: role }, crypto.randomUUID());
      if (r.ok) onDone();
      else setError(errorText(r.code, r.status));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Invite user" isOpen onClose={onClose} footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void submit()}>Send invitation</Button></>}>
      <TextField label="Email" name="email" maxLength={254} inputMode="email" isRequired value={email} onChange={setEmail} />
      <TextField label="Display name" name="display_name" maxLength={120} isRequired value={name} onChange={setName} />
      <RadioGroup<Role> label="Role" name="partner_role" options={ROLES} value={role} onChange={setRole} />
      <DialogError text={error} />
    </Dialog>
  );
}

function UsersTab({ partner, users, canManage }: { partner: Partner; users: readonly PartnerUser[] | null; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [notice, setNotice] = useState<string>();
  const [inviting, setInviting] = useState(false);
  const [deactivating, setDeactivating] = useState<PartnerUser | null>(null);
  const [changing, setChanging] = useState<PartnerUser | null>(null);
  if (!users) return <LoadFailed title="The users could not be loaded." />;

  const done = (r: ActionResult<unknown>, ok: string) => {
    if (r.ok) { setNotice(undefined); toast.show({ tone: 'success', title: ok }); router.refresh(); } else setNotice(errorText(r.code, r.status));
  };
  const hasAdmin = users.some((u) => u.partner_role === 'partner_admin' && u.status === 'active');
  const columns: ColumnDef<PartnerUser>[] = [
    { id: 'name', header: 'Name', isRowHeader: true, cell: (u) => u.display_name },
    { id: 'email', header: 'Email', cell: (u) => u.email_masked },
    { id: 'role', header: 'Role', cell: (u) => roleLabel(u.partner_role) },
    { id: 'status', header: 'Status', cell: (u) => <Chip code={u.status} /> },
    { id: 'mfa', header: 'MFA', cell: (u) => (u.mfa_enrolled ? 'Enrolled' : 'Not enrolled') },
    { id: 'login', header: 'Last sign-in', cell: (u) => (u.last_login_at ? <Ad value={u.last_login_at} withTime /> : '—') },
    {
      id: 'actions', header: 'Actions',
      cell: (u) => (!canManage ? null : u.status === 'active' ? (
        <>
          <Button size="sm" onPress={() => setChanging(u)}>Change role</Button>
          <Button size="sm" variant="ghost" onPress={() => setDeactivating(u)}>Deactivate</Button>
        </>
      ) : u.status === 'deactivated' ? (
        <Button size="sm" onPress={async () => done(await reactivatePartnerUserAction(u.id, u.version), 'User reactivated.')}>Reactivate</Button>
      ) : null),
    },
  ];
  return (
    <>
      {notice ? <Notice text={notice} /> : null}
      {!hasAdmin ? <Banner tone="warning" title="This partner has no active administrator." /> : null}
      {canManage ? <Button onPress={() => setInviting(true)}>Invite user</Button> : null}
      <DataTable caption="Partner users" columns={columns} rows={users} getRowId={(u) => u.id} emptyState={{ title: 'No users yet', body: 'Invite an administrator so the partner can sign in.' }} />
      {inviting ? <InviteDialog partnerId={partner.id} onClose={() => setInviting(false)} onDone={() => { setInviting(false); toast.show({ tone: 'success', title: 'Invitation sent.' }); router.refresh(); }} /> : null}
      <ConfirmDialog
        key={`deactivate-${deactivating?.id ?? ''}`}
        title="Deactivate user"
        isOpen={deactivating !== null}
        confirmLabel="Deactivate"
        tone="danger"
        onCancel={() => setDeactivating(null)}
        body={<p>{deactivating?.display_name} will no longer be able to sign in.</p>}
        requireReason={{ codedSet: 'partners.partner_user_deactivate_reasons', options: REASONS.partner_user_deactivate_reasons }}
        onConfirm={async ({ reasonCode }) => {
          const u = deactivating;
          if (!u || !reasonCode) return;
          setDeactivating(null);
          done(await deactivatePartnerUserAction(u.id, u.version, reasonCode), 'User deactivated.');
        }}
      />
      <ConfirmDialog
        key={`role-${changing?.id ?? ''}`}
        title="Change role"
        isOpen={changing !== null}
        confirmLabel="Change role"
        onCancel={() => setChanging(null)}
        body={<p>{changing?.display_name} will become {changing?.partner_role === 'partner_admin' ? 'a member' : 'an administrator'}.</p>}
        onConfirm={async () => {
          const u = changing;
          if (!u) return;
          setChanging(null);
          done(await changePartnerUserRoleAction(u.id, u.version, u.partner_role === 'partner_admin' ? 'partner_member' : 'partner_admin'), 'Role changed.');
        }}
      />
    </>
  );
}

function ManifestsTab({ rows }: { rows: readonly ManifestSummary[] | null }) {
  if (!rows) return <LoadFailed title="The manifests could not be loaded." />;
  const columns: ColumnDef<ManifestSummary>[] = [
    { id: 'no', header: 'Manifest', isRowHeader: true, cell: (m) => <a className="lims-link lims-mono" href={`/partners/manifests/${m.id}`}>{m.manifest_no}</a> },
    { id: 'state', header: 'State', cell: (m) => <Chip code={m.state} /> },
    { id: 'samples', header: 'Samples', align: 'end', cell: (m) => m.line_count },
    { id: 'failed', header: 'Needs attention', align: 'end', cell: (m) => m.lines_failed },
    { id: 'submitted', header: 'Submitted', cell: (m) => (m.submitted_at ? <Ad value={m.submitted_at} withTime /> : '—') },
  ];
  return <DataTable caption="Partner manifests" columns={columns} rows={rows} getRowId={(m) => m.id} emptyState={{ title: 'No manifests' }} />;
}

function DoctorsTab({ rows }: { rows: readonly Referrer[] | null }) {
  if (!rows) return <LoadFailed title="The doctors could not be loaded." />;
  const columns: ColumnDef<Referrer>[] = [
    { id: 'name', header: 'Name', isRowHeader: true, cell: (r) => r.display_name },
    { id: 'qual', header: 'Qualification', cell: (r) => r.qualification ?? '—' },
    { id: 'state', header: 'State', cell: (r) => <Chip code={r.mapping_state} /> },
  ];
  return <DataTable caption="Partner doctors" columns={columns} rows={rows} getRowId={(r) => r.id} emptyState={{ title: 'No doctors' }} />;
}

export function PartnerDetail({ partner, users, manifests, referrers, permissions }: { partner: Partner; users: readonly PartnerUser[] | null; manifests: readonly ManifestSummary[] | null; referrers: readonly Referrer[] | null; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [suspending, setSuspending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const canManage = hasPerm(permissions, 'partners.partner.manage');
  const suspended = partner.status === 'suspended';

  const done = (r: ActionResult<unknown>, ok: string) => {
    if (r.ok) { setNotice(undefined); toast.show({ tone: 'success', title: ok }); router.refresh(); } else setNotice(errorText(r.code, r.status));
  };
  const tabs = [
    { id: 'overview', label: 'Overview' }, { id: 'users', label: 'Users' },
    ...(hasPerm(permissions, 'partners.manifest.receive') ? [{ id: 'manifests', label: 'Manifests' }] : []),
    ...(hasPerm(permissions, 'partners.referrer.map') ? [{ id: 'doctors', label: 'Doctors' }] : []),
  ];
  const synced = (label: string, at?: string): ReactNode => <p>{label}: {at ? <Ad value={at} withTime /> : 'not yet'}</p>;
  const contact = [partner.contact_email, partner.contact_phone_e164, partner.address_text].filter(Boolean).join(' · ');

  return (
    <section aria-label="Partner">
      <PageHeader
        title={partner.name}
        helpKey="partners.detail"
        breadcrumbs={[{ label: 'Partners', href: '/partners' }, { label: partner.partner_code }]}
        status={<Chip code={partner.status} />}
        actions={canManage ? (
          <>
            {suspended ? <Button onPress={async () => done(await reactivatePartnerAction(partner.id, partner.version), 'Partner reactivated.')}>Reactivate</Button> : <Button onPress={() => setSuspending(true)}>Suspend</Button>}
            <Menu trigger={<Button>Resync data</Button>} items={RESYNC} onAction={async (id) => done(await resyncPartnerAction(partner.id, [id as (typeof RESYNC)[number]['id']]), 'Resync queued.')} />
          </>
        ) : null}
      />
      {notice ? <Notice text={notice} /> : null}
      <Tabs items={tabs} selectedId={tab} onChange={setTab} aria-label="Partner sections">
        {tab === 'overview' ? (
          <>
            <DescriptionList
              columns={2}
              items={[
                { term: 'Partner code', value: <span className="lims-mono">{partner.partner_code}</span> },
                { term: 'Name', value: partner.name },
                { term: 'Credit party', value: `${partner.credit_party.party_code} · ${partner.credit_party.name}` },
                { term: 'Receiving centre', value: partner.receiving_centre.name },
                { term: 'Orders are created', value: partner.conversion_mode === 'on_submit' ? 'As soon as the partner submits' : 'When the lab receives the samples' },
                { term: 'Contact', value: contact || '—' },
              ]}
            />
            {synced('Prices synced', partner.projection_status?.price_list_synced_at)}
            {synced('Statements synced', partner.projection_status?.statements_synced_at)}
          </>
        ) : null}
        {tab === 'users' ? <UsersTab partner={partner} users={users} canManage={canManage} /> : null}
        {tab === 'manifests' ? <ManifestsTab rows={manifests} /> : null}
        {tab === 'doctors' ? <DoctorsTab rows={referrers} /> : null}
      </Tabs>
      <ConfirmDialog
        title="Suspend partner"
        isOpen={suspending}
        confirmLabel="Suspend"
        tone="danger"
        onCancel={() => setSuspending(false)}
        body={<p>The partner can no longer submit manifests. Samples already submitted can still be received.</p>}
        requireReason={{ codedSet: 'partners.partner_suspend_reasons', options: SUSPEND_REASON, freeText: { maxLength: 300, isRequired: false } }}
        onConfirm={async ({ reasonCode, reasonText }) => {
          if (!reasonCode) return;
          setSuspending(false);
          done(await suspendPartnerAction(partner.id, partner.version, reasonCode, reasonText), 'Partner suspended.');
        }}
      />
    </section>
  );
}
