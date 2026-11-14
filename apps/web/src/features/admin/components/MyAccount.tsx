'use client';
// ME-1 My account (US-A5/A6 UI): Profile (read-only), Security (change password, two-step factors), Sessions.
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { PasswordField } from '../auth/PasswordField';
import { changeOwnPassword, removeOwnMfaFactor, revokeOwnSession } from '../actions';
import { Badge } from '../Grid';
import { Alert, Tabs } from '../ui';
import { copyFor, fmt, type RoleRef, type SessionSummary } from '../lib';
import { SessionsGrid } from './SessionsGrid';

export interface Me { display_name: string; email: string; roles: RoleRef[]; centre_scope: { all: boolean; centre_ids: string[] }; mfa: { enrolled: boolean; level: string }; last_login_at?: string }
export interface Factor { factor_id: string; friendly_name?: string; status: string; verified_at?: string }

export function MyAccount({ me, sessions, factors, mfaRequired }: { me: Me; sessions: SessionSummary[]; factors: Factor[]; mfaRequired: boolean }) {
  const [tab, setTab] = useState('Profile');
  return (
    <main className="lims-page">
      <header className="lims-page-header"><h1>My account</h1></header>
      <Tabs items={['Profile', 'Security', 'Sessions']} selected={tab} onChange={setTab} label="Account sections">
        {tab === 'Profile' ? (
          <dl className="lims-dl">
            <dt>Name</dt><dd>{me.display_name}</dd>
            <dt>Email</dt><dd>{me.email}</dd>
            <dt>Roles</dt><dd>{me.roles.map((r) => r.name).join(', ') || '—'}</dd>
            <dt>Centre access</dt><dd>{me.centre_scope.all ? 'All centres' : `${me.centre_scope.centre_ids.length} selected centres`}</dd>
            <dt>Last login</dt><dd>{fmt(me.last_login_at)}</dd>
          </dl>
        ) : null}
        {tab === 'Security' ? <Security me={me} factors={factors} mfaRequired={mfaRequired} /> : null}
        {tab === 'Sessions' ? <SessionsGrid sessions={sessions} variant="me" onRevoke={revokeOwnSession} buttonLabel="Log out this session" /> : null}
      </Tabs>
    </main>
  );
}

function Security({ me, factors: initial, mfaRequired }: { me: Me; factors: Factor[]; mfaRequired: boolean }) {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fail, setFail] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  const [busy, setBusy] = useState(false);
  const [factors, setFactors] = useState(initial.filter((f) => f.status === 'verified'));
  const [removing, setRemoving] = useState<Factor | null>(null);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const lastProtected = mfaRequired && factors.length <= 1;

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const er: Record<string, string> = {};
    if (!cur) er['cur'] = 'Enter your current password';
    if (next.length < 12 || next.length > 128) er['next'] = 'Use 12–128 characters';
    if (confirm !== next) er['confirm'] = 'The passwords do not match';
    setErrors(er);
    setFail(null);
    if (Object.keys(er).length) return;
    setBusy(true);
    const r = await changeOwnPassword(cur, next);
    setBusy(false);
    if (!r.ok) { setFail({ text: copyFor(r.code), requestId: r.requestId }); return; }
    setCur(''); setNext(''); setConfirm('');
    toast.show({ tone: 'success', title: 'Password changed. Your other sessions were logged out.' });
  };

  return (
    <>
      <form onSubmit={change} noValidate className="lims-form" aria-label="Change password">
        <h2>Change password</h2>
        {fail ? <Alert text={fail.text} requestId={fail.requestId} /> : null}
        <PasswordField label="Current password" name="current_password" autoComplete="current-password" maxLength={128} value={cur} onChange={setCur} error={errors['cur']} />
        <PasswordField label="New password" name="new_password" autoComplete="new-password" maxLength={128} value={next} onChange={setNext} error={errors['next']} />
        <PasswordField label="Confirm password" name="confirm_password" autoComplete="new-password" maxLength={128} value={confirm} onChange={setConfirm} error={errors['confirm']} />
        <Button type="submit" variant="primary" isLoading={busy}>Change password</Button>
      </form>
      <section className="lims-card" aria-labelledby="mfa-h">
        <h2 id="mfa-h">Two-step verification</h2>
        <p>Status: <Badge text={me.mfa.enrolled ? 'On' : 'Off'} />.</p>
        {!factors.length ? <Link href="/auth/mfa/enrol" className="lims-btn">Set up</Link> : null}
        {removeErr && !removing ? <Alert text={removeErr} /> : null}
        <ul>
          {factors.map((f) => (
            <li key={f.factor_id}>
              {f.friendly_name ?? 'Authenticator'} — added {fmt(f.verified_at)}{' '}
              <span {...(lastProtected ? { title: 'Your role requires two-step verification' } : {})}>
                <Button size="sm" isDisabled={lastProtected} onPress={() => { setRemoveErr(null); setRemoving(f); }}>Remove</Button>
              </span>
              {lastProtected ? <span className="lims-description"> Your role requires two-step verification</span> : null}
            </li>
          ))}
        </ul>
      </section>
      <ConfirmDialog
        title="Remove this authenticator?"
        body={<>{removeErr && removing ? <Alert text={removeErr} /> : null}<p>You will need to set up two-step verification again to use privileged actions.</p></>}
        confirmLabel="Remove"
        tone="danger"
        isOpen={removing !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          const r = await removeOwnMfaFactor(removing.factor_id);
          if (!r.ok) { setRemoveErr(copyFor(r.code)); return; }
          setFactors((xs) => xs.filter((x) => x.factor_id !== removing.factor_id));
          setRemoving(null);
          toast.show({ tone: 'success', title: 'Authenticator removed.' });
        }}
      />
    </>
  );
}
