'use client';
// ME-1 My account (US-A5/A6 UI): Profile (read-only), Security (change password, two-step factors), Sessions.
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import { PasswordField } from '../auth/PasswordField';
import { changeOwnPassword, removeOwnMfaFactor, revokeOwnSession } from '../actions';
import { Badge, Grid } from '../Grid';
import { Alert, Tabs } from '../ui';
import { copyFor, fmt, type RoleRef, type SessionSummary } from '../lib';
import { SessionsGrid } from './SessionsGrid';

export interface Me { display_name: string; email: string; roles: RoleRef[]; centre_scope: { all: boolean; centre_ids: string[] }; mfa: { enrolled: boolean; level: string }; last_login_at?: string }
export interface Factor { factor_id: string; friendly_name?: string; status: string; verified_at?: string }

/** T0D-ELABMENU-2 (LD-340): a refused or failed read; shown as such, never as an empty list. */
export interface ReadFail { code: string; requestId?: string }

/** auth.step_up_required -> step up prompt (link to /auth/mfa); anything else -> "Could not load ..." with the reference. */
function ReadFailed({ fail, what }: { fail: ReadFail; what: string }) {
  if (fail.code === 'auth.step_up_required') {
    return <p>Confirm it is you to see {what}. <Link href="/auth/mfa" className="lims-btn">Verify with two-step</Link></p>;
  }
  return <Alert text={`Could not load ${what}`} requestId={fail.requestId} />;
}

export function MyAccount({ me, sessions, factors, mfaRequired }: { me: Me; sessions: SessionSummary[] | ReadFail; factors: Factor[] | ReadFail; mfaRequired: boolean }) {
  const [tab, setTab] = useState('Profile');
  return (
    <main className="lims-page">
      <PageHeader title="My account" helpKey="admin.me" />
      <Tabs items={['Profile', 'Security', 'Sessions']} selected={tab} onChange={setTab} label="Account sections">
        {tab === 'Profile' ? (
          // T0D-UIX-4 (LD-442): label and value pairs are the kit DescriptionList
          <DescriptionList items={[
            { term: 'Name', value: me.display_name },
            { term: 'Email', value: me.email },
            { term: 'Roles', value: me.roles.map((r) => r.name).join(', ') || '—' },
            { term: 'Centre access', value: me.centre_scope.all ? 'All centres' : `${me.centre_scope.centre_ids.length} selected centres` },
            { term: 'Last login', value: fmt(me.last_login_at) },
          ]} />
        ) : null}
        {tab === 'Security' ? <Security me={me} factors={factors} mfaRequired={mfaRequired} /> : null}
        {tab === 'Sessions' ? (Array.isArray(sessions)
          ? <SessionsGrid sessions={sessions} variant="me" onRevoke={revokeOwnSession} buttonLabel="Log out this session" />
          : <ReadFailed fail={sessions} what="your sessions" />) : null}
      </Tabs>
    </main>
  );
}

function Security({ me, factors: initial, mfaRequired }: { me: Me; factors: Factor[] | ReadFail; mfaRequired: boolean }) {
  const loadFail = Array.isArray(initial) ? null : initial;
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fail, setFail] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  const [busy, setBusy] = useState(false);
  const [factors, setFactors] = useState(Array.isArray(initial) ? initial.filter((f) => f.status === 'verified') : []);
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
      {/* T0D-UIGUARD-1-ADMIN (LD-436 Card title row, LD-439): each block is a kit Card; the factors are a table, not a raw list */}
      <Card title="Change password">
      <form onSubmit={change} noValidate className="lims-form" aria-label="Change password">
        {fail ? <Alert text={fail.text} requestId={fail.requestId} /> : null}
        <PasswordField label="Current password" name="current_password" autoComplete="current-password" maxLength={128} value={cur} onChange={setCur} error={errors['cur']} />
        <PasswordField label="New password" name="new_password" autoComplete="new-password" maxLength={128} value={next} onChange={setNext} error={errors['next']} />
        <PasswordField label="Confirm password" name="confirm_password" autoComplete="new-password" maxLength={128} value={confirm} onChange={setConfirm} error={errors['confirm']} />
        <Button type="submit" variant="primary" isLoading={busy}>Change password</Button>
      </form>
      </Card>
      <Card title="Two-step verification">
        <p>Status: <Badge text={me.mfa.enrolled ? 'On' : 'Off'} />.</p>
        {loadFail ? <ReadFailed fail={loadFail} what="your two-step factors" /> : null}
        {!loadFail && !factors.length ? <Link href="/auth/mfa/enrol" className="lims-btn">Set up</Link> : null}
        {removeErr && !removing ? <Alert text={removeErr} /> : null}
        {factors.length ? (
          <Grid label="Authenticators" columns={['Authenticator', 'Added', 'Action']}
            rows={factors.map((f) => ({
              key: f.factor_id,
              cells: [
                f.friendly_name ?? 'Authenticator',
                `added ${fmt(f.verified_at)}`,
                <span key="r">
                  <span {...(lastProtected ? { title: 'Your role requires two-step verification' } : {})}>
                    <Button size="sm" isDisabled={lastProtected} onPress={() => { setRemoveErr(null); setRemoving(f); }}>Remove</Button>
                  </span>
                  {lastProtected ? <span className="lims-description"> Your role requires two-step verification</span> : null}
                </span>,
              ],
            }))} />
        ) : null}
      </Card>
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
