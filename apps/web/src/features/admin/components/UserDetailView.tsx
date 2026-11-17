'use client';
// AD-3 User detail (US-B2..B6): header + permission-gated actions menu, tabs Profile / Roles / Centre access / Signatory / Sessions / History.
// Every write sends the latest `version` as If-Match; 409 → reload dialog, auth.mfa_required → step-up dialog (04-UI-UX §3).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { Menu } from '@lims/ui/components/Menu';
import { useToast } from '@lims/ui/components/Toast';
import { revokeSession, setUserCentreScope, setUserRoles, updateUser, uploadUserSignature, userAction, userHistory, type UserOp } from '../actions';
import { Badge, Grid, Time } from '../Grid';
import { Alert, Field, Picker, Tabs, useFailure } from '../ui';
import { E164_RE, SESSION_WARNING, STATUS_LABEL, codesOf, copyFor, fmt, isHubLabPermission, qs, type Branch, type Centre, type Role, type SessionSummary, type UserDetail } from '../lib';
import { CentreScope, type Scope } from './CentreScope';
import { SessionsGrid } from './SessionsGrid';

const REASONS = [
  { value: 'left_organisation', label: 'Left organisation' },
  { value: 'security_concern', label: 'Security concern' },
  { value: 'policy_violation', label: 'Policy violation' },
  { value: 'other', label: 'Other' },
];
const SIG_TYPES = ['image/png', 'image/jpeg'];
const SIG_MAX = 1024 * 1024;

interface Props { user: UserDetail; perms: string[]; roles: Role[]; centres: Centre[]; branches: Branch[]; sessions: SessionSummary[] }

export function UserDetailView({ user: initial, perms, roles, centres, branches, sessions }: Props) {
  const toast = useToast();
  const [user, setUser] = useState(initial);
  const [tab, setTab] = useState('Profile');
  const [dialog, setDialog] = useState<UserOp | null>(null);
  const can = (p: string) => perms.includes(p);
  const manage = can('identity.user.manage');
  const id = user.membership_id;
  const codes = codesOf(user.roles.map((r) => r.role_id), roles);
  const tabs = ['Profile', 'Roles', 'Centre access', ...(codes.includes('lab.result.approve') ? ['Signatory'] : []), 'Sessions', ...(can('audit.log.read') ? ['History'] : [])];
  /** Applies a successful write: keep the newest representation/version for the next If-Match. */
  const applied = (data: unknown, msg: string) => {
    if (data && typeof data === 'object' && 'version' in data) setUser((u) => ({ ...u, ...(data as Partial<UserDetail>) }));
    toast.show({ tone: 'success', title: msg });
  };

  const items = manage
    ? [
        user.is_locked ? { id: 'unlock', label: 'Unlock' } : { id: 'lock', label: 'Lock' },
        user.status === 'deactivated' ? { id: 'reactivate', label: 'Reactivate' } : { id: 'deactivate', label: 'Deactivate', isDanger: true },
        ...(user.status === 'invited' ? [{ id: 'resend-invitation', label: 'Resend invitation' }] : []),
        { id: 'reset-mfa', label: 'Reset two-step verification' },
        { id: 'revoke-sessions', label: 'Log out all sessions' },
      ]
    : [];

  return (
    <main className="lims-page">
      <header className="lims-page-header">
        <h1>{user.display_name}</h1>
        <p>
          <Badge text={STATUS_LABEL[user.status] ?? user.status} />
          {user.is_locked ? <> <Badge text="Locked" /></> : null}
        </p>
        {items.length ? <Menu trigger={<Button>Actions</Button>} items={items} onAction={(k) => setDialog(k as UserOp)} /> : null}
      </header>
      <Tabs items={tabs} selected={tab} onChange={setTab} label="User sections">
        {tab === 'Profile' ? <ProfileTab user={user} manage={manage} onSaved={applied} /> : null}
        {tab === 'Roles' ? <RolesTab user={user} roles={roles} manage={manage} onSaved={applied} /> : null}
        {tab === 'Centre access' ? <ScopeTab user={user} roles={roles} centres={centres} branches={branches} manage={manage} onSaved={applied} /> : null}
        {tab === 'Signatory' ? <SignatoryTab user={user} manage={manage} onSaved={applied} /> : null}
        {tab === 'Sessions' ? <SessionsGrid sessions={sessions} variant="user" onRevoke={can('identity.session.revoke') ? revokeSession : undefined} /> : null}
        {tab === 'History' ? <HistoryTab id={id} /> : null}
      </Tabs>
      <ActionDialogs op={dialog} user={user} onClose={() => setDialog(null)} onDone={(d, m) => { setDialog(null); applied(d, m); }} />
    </main>
  );
}

// ---------------------------------------------------------------- actions menu dialogs (US-B4, B5)
function ActionDialogs({ op, user, onClose, onDone }: { op: UserOp | null; user: UserDetail; onClose: () => void; onDone: (d: unknown, msg: string) => void }) {
  const [err, setErr] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  const failure = useFailure();
  useEffect(() => { setErr(null); }, [op]);
  const run = async (o: UserOp, msg: string, reason?: { reason_code?: string; reason_text?: string }) => {
    const r = await userAction(user.membership_id, o, user.version, reason);
    if (r.ok) { onDone(r.data, msg); return; }
    if (r.code === 'common.version_conflict' || r.code === 'auth.mfa_required') { onClose(); failure.set(r); return; }
    setErr({ text: copyFor(r.code), requestId: r.requestId });
  };
  const inline = err ? <Alert text={err.text} requestId={err.requestId} /> : null;
  const simple: Partial<Record<UserOp, { title: string; body: string; label: string; msg: string }>> = {
    unlock: { title: 'Unlock user?', body: 'The user can log in again.', label: 'Unlock', msg: 'User unlocked.' },
    reactivate: { title: 'Reactivate user?', body: 'The user regains access with their current roles.', label: 'Reactivate', msg: 'User reactivated.' },
    'resend-invitation': { title: 'Resend invitation?', body: 'A new invitation email is sent; the old link stops working.', label: 'Resend', msg: 'Invitation sent.' },
    'revoke-sessions': { title: 'Log out all sessions?', body: 'The user is logged out on every device.', label: 'Log out all', msg: 'Sessions logged out.' },
  };
  const s = op ? simple[op] : undefined;
  return (
    <>
      {op && s ? (
        <ConfirmDialog title={s.title} body={<>{inline}<p>{s.body}</p></>} confirmLabel={s.label} isOpen onCancel={onClose} onConfirm={() => run(op, s.msg)} />
      ) : null}
      {op === 'lock' || op === 'deactivate' ? (
        <ReasonDialog
          title={op === 'lock' ? 'Lock user' : 'Deactivate user'}
          copy={op === 'lock' ? 'Locked users are logged out immediately and cannot log in until unlocked.' : 'Deactivated users are logged out and lose access to this lab. Their history is kept.'}
          confirm={op === 'lock' ? 'Lock' : 'Deactivate'}
          inline={inline}
          onClose={onClose}
          onSubmit={(reason) => run(op, op === 'lock' ? 'User locked.' : 'User deactivated.', reason)}
        />
      ) : null}
      {op === 'reset-mfa' ? <ResetMfaDialog inline={inline} onClose={onClose} onSubmit={(t) => run('reset-mfa', 'Two-step verification reset.', { reason_text: t })} /> : null}
      {failure.dialogs}
    </>
  );
}

function ReasonDialog({ title, copy, confirm, inline, onClose, onSubmit }: { title: string; copy: string; confirm: string; inline: React.ReactNode; onClose: () => void; onSubmit: (r: { reason_code: string; reason_text?: string }) => Promise<void> }) {
  const [code, setCode] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!code[0]) e['code'] = 'Choose a reason';
    if (code[0] === 'other' && !text.trim()) e['text'] = 'Details are required for Other';
    if (text.length > 500) e['text'] = 'Use 500 characters or fewer';
    setErrors(e);
    if (Object.keys(e).length || busy) return;
    setBusy(true);
    await onSubmit({ reason_code: code[0]!, ...(text.trim() ? { reason_text: text.trim() } : {}) });
    setBusy(false);
  };
  return (
    <Dialog title={title} isOpen onClose={onClose} size="sm" isDismissable={false}
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="danger" onPress={() => void submit()} isLoading={busy}>{confirm}</Button></>}>
      {inline}
      <p>{copy}</p>
      <Picker label="Reason" options={REASONS} value={code} onChange={setCode} error={errors['code']} />
      <Field label="Details" multiline value={text} onChange={setText} error={errors['text']} hint="Up to 500 characters; required for Other." />
    </Dialog>
  );
}

function ResetMfaDialog({ inline, onClose, onSubmit }: { inline: React.ReactNode; onClose: () => void; onSubmit: (t: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  return (
    <ConfirmDialog
      title="Reset two-step verification?"
      body={<>{inline}<p>All the user&apos;s authenticator factors are removed and their sessions end. They set up two-step verification again at next login.</p>
        <Field label="Reason" multiline value={text} onChange={setText} error={error} /></>}
      confirmLabel="Reset"
      tone="danger"
      isOpen
      onCancel={onClose}
      onConfirm={async () => {
        if (!text.trim() || text.length > 500) { setError('Enter a reason (up to 500 characters)'); return; }
        setError(undefined);
        await onSubmit(text.trim());
      }}
    />
  );
}

// ---------------------------------------------------------------- tabs
type Saved = (d: unknown, msg: string) => void;

function ProfileTab({ user, manage, onSaved }: { user: UserDetail; manage: boolean; onSaved: Saved }) {
  const [name, setName] = useState(user.display_name);
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const failure = useFailure();
  const save = async () => {
    const e: Record<string, string> = {};
    if (!name.trim() || name.length > 120) e['name'] = 'Enter 1–120 characters';
    if (phone.trim() && !E164_RE.test(phone.trim())) e['phone'] = 'Use the international format, e.g. +9779812345678';
    setErrors(e);
    failure.clear();
    if (Object.keys(e).length) return;
    const patch = { ...(name.trim() !== user.display_name ? { display_name: name.trim() } : {}), ...(phone.trim() ? { phone_e164: phone.trim() } : {}) };
    if (!Object.keys(patch).length) return;
    const r = await updateUser(user.membership_id, user.version, patch);
    if (r.ok) { setPhone(''); onSaved(r.data, 'Profile saved.'); } else failure.set(r);
  };
  return (
    <section>
      {failure.banner}
      <Field label="Email" value={user.email_masked} readOnly />
      <Field label="Full name" value={name} onChange={setName} readOnly={!manage} error={errors['name']} />
      <Field label="Mobile" type="tel" value={phone} onChange={setPhone} readOnly={!manage} error={errors['phone']} maxLength={16}
        hint={user.phone_masked ? `Current: ${user.phone_masked}. Enter a new number to replace it.` : 'Optional, international format.'} />
      {manage ? <Button variant="primary" onPress={() => void save()}>Save</Button> : null}
      {failure.dialogs}
    </section>
  );
}

function RolesTab({ user, roles, manage, onSaved }: { user: UserDetail; roles: Role[]; manage: boolean; onSaved: Saved }) {
  const [ids, setIds] = useState(user.roles.map((r) => r.role_id));
  const [error, setError] = useState<string>();
  const failure = useFailure();
  const hub = codesOf(ids, roles).some(isHubLabPermission) && !user.all_centres;
  const save = async () => {
    if (!ids.length) { setError('Choose at least one role'); return; }
    setError(undefined);
    failure.clear();
    const r = await setUserRoles(user.membership_id, user.version, ids);
    if (r.ok) onSaved(r.data, 'Roles saved.'); else failure.set(r);
  };
  return (
    <section>
      {failure.banner}
      <p>{SESSION_WARNING}</p>
      <Picker label="Roles" multiple value={ids} onChange={setIds} error={error} disabled={!manage}
        options={roles.filter((r) => r.is_active || ids.includes(r.role_id)).map((r) => ({ value: r.role_id, label: r.name, tag: r.mfa_required ? 'MFA required' : undefined }))} />
      {hub ? <Banner tone="warning" title="These roles receive or work on samples. Check this user's centre access." /> : null}
      {manage ? <Button variant="primary" onPress={() => void save()}>Save</Button> : null}
      {failure.dialogs}
    </section>
  );
}

function ScopeTab({ user, roles, centres, branches, manage, onSaved }: { user: UserDetail; roles: Role[]; centres: Centre[]; branches: Branch[]; manage: boolean; onSaved: Saved }) {
  const [scope, setScope] = useState<Scope>({ all: user.all_centres, centres: user.centre_ids ?? [], branches: user.branch_ids ?? [] });
  const [error, setError] = useState<string>();
  const failure = useFailure();
  const hub = codesOf(user.roles.map((r) => r.role_id), roles).some(isHubLabPermission);
  const save = async () => {
    if (!scope.all && !scope.centres.length) { setError('Choose at least one centre, or All centres'); return; }
    setError(undefined);
    failure.clear();
    const r = await setUserCentreScope(user.membership_id, user.version, { all_centres: scope.all, centre_ids: scope.all ? [] : scope.centres, branch_ids: scope.branches });
    if (r.ok) onSaved(r.data, 'Centre access saved.'); else failure.set(r);
  };
  return (
    <section>
      {failure.banner}
      <p>{SESSION_WARNING}</p>
      <CentreScope scope={scope} onChange={setScope} centres={centres} branches={branches} hubLab={hub} centresError={error} disabled={!manage} />
      {manage ? <Button variant="primary" onPress={() => void save()}>Save</Button> : null}
      {failure.dialogs}
    </section>
  );
}

function SignatoryTab({ user, manage, onSaved }: { user: UserDetail; manage: boolean; onSaved: Saved }) {
  const [title, setTitle] = useState(user.signatory?.display_title ?? '');
  const [reg, setReg] = useState(user.signatory?.registration_no ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fileErr, setFileErr] = useState<string | null>(null);
  const failure = useFailure();
  const save = async () => {
    const e: Record<string, string> = {};
    if (title.length > 80) e['title'] = 'Use 80 characters or fewer';
    if (reg.length > 40) e['reg'] = 'Use 40 characters or fewer';
    setErrors(e);
    failure.clear();
    if (Object.keys(e).length) return;
    const unset = [...(!title.trim() && user.signatory?.display_title ? ['signatory_title'] : []), ...(!reg.trim() && user.signatory?.registration_no ? ['signatory_registration_no'] : [])];
    const patch = {
      ...(title.trim() && title.trim() !== user.signatory?.display_title ? { signatory_title: title.trim() } : {}),
      ...(reg.trim() && reg.trim() !== user.signatory?.registration_no ? { signatory_registration_no: reg.trim() } : {}),
      ...(unset.length ? { unset } : {}),
    };
    if (!Object.keys(patch).length) return;
    const r = await updateUser(user.membership_id, user.version, patch);
    if (r.ok) onSaved(r.data, 'Signatory details saved.'); else failure.set(r);
  };
  const upload = async (f: File | undefined) => {
    setFileErr(null);
    if (!f) return;
    if (!SIG_TYPES.includes(f.type)) { setFileErr('Use a PNG or JPEG image.'); return; }
    if (f.size > SIG_MAX) { setFileErr('The image must be 1 MB or smaller.'); return; }
    const form = new FormData();
    form.set('file', f, f.name);
    const r = await uploadUserSignature(user.membership_id, form);
    if (r.ok) onSaved(r.data, 'Signature uploaded.'); else setFileErr(copyFor(r.code));
  };
  return (
    <section>
      {failure.banner}
      <p>This signature is printed on reports this user approves (configured by report templates).</p>
      <Field label="Title" value={title} onChange={setTitle} readOnly={!manage} error={errors['title']} hint="Up to 80 characters, e.g. MD Pathology" />
      <Field label="Registration no. (e.g. NMC)" value={reg} onChange={setReg} readOnly={!manage} error={errors['reg']} />
      {manage ? (
        <div className="lims-field">
          <label htmlFor="sig-file" className="lims-label">Signature image</label>
          <input id="sig-file" type="file" accept="image/png,image/jpeg" aria-describedby="sig-hint" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
          <p id="sig-hint" className="lims-description">PNG or JPEG, up to 1 MB. Transparent PNG, at least 600 px wide works best</p>
        </div>
      ) : null}
      {user.signatory?.signature_asset_id ? <p>A signature image is on file.</p> : null}
      {fileErr ? <Alert text={fileErr} /> : null}
      {manage ? <Button variant="primary" onPress={() => void save()}>Save</Button> : null}
      {failure.dialogs}
    </section>
  );
}

function HistoryTab({ id }: { id: string }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [err, setErr] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  useEffect(() => {
    let live = true;
    void userHistory(id).then((r) => { if (!live) return; if (r.ok) setRows(r.data.data); else setErr({ text: copyFor(r.code), requestId: r.requestId }); });
    return () => { live = false; };
  }, [id]);
  return (
    <section>
      {err ? <Alert text={err.text} requestId={err.requestId} /> : null}
      {rows === null && !err ? <p>Loading…</p> : null}
      {rows?.length ? (
        <Grid label="History" columns={['Time', 'User', 'Action', 'Table', 'Changed fields']}
          rows={rows.map((a, i) => {
            const at = String(a['occurred_at'] ?? '');
            const actor = a['actor'] as { display_name?: string } | undefined;
            return { key: String(a['audit_id'] ?? i), cells: [<Time key="t" iso={at} label={fmt(at)} />, actor?.display_name ?? '—', String(a['action'] ?? ''), String(a['table'] ?? ''), ((a['changed_columns'] as string[] | undefined) ?? []).join(', ')] };
          })} />
      ) : rows ? <p>No recorded changes yet.</p> : null}
      <Link href={`/admin/audit${qs({ row_id: id })}`}>Open in the audit log</Link>
    </section>
  );
}
