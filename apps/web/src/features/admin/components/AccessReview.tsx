'use client';
// AD-15 Access review (US-G1): every active membership with roles/centres/MFA; review banner (warning when > 90 days or none);
// [Record review completed] with the count auto-filled. Deliberately no export control on this screen.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { useToast } from '@lims/ui/components/Toast';
import { recordAccessReview } from '../actions';
import { Grid, Time } from '../Grid';
import { Alert, Field } from '../ui';
import { DAY_MS, STATUS_LABEL, copyFor, fmt, rolesText, type UserSummary } from '../lib';

export interface Review { access_review_id: string; reviewed_by_membership_id: string; memberships_reviewed: number; reviewed_at: string; notes?: string }

export function AccessReview({ users, last, canRecord, now }: { users: UserSummary[]; last: Review | null; canRecord: boolean; now: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const [fail, setFail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const by = last ? users.find((u) => u.membership_id === last.reviewed_by_membership_id)?.display_name ?? 'an administrator' : '';
  const due = !last || now - Date.parse(last.reviewed_at) > 90 * DAY_MS;
  const submit = async () => {
    if (busy) return;
    if (notes.length > 2000) { setError('Use 2000 characters or fewer'); return; }
    setError(undefined);
    setBusy(true);
    const r = await recordAccessReview(users.length, notes.trim() || undefined);
    setBusy(false);
    if (!r.ok) { setFail(copyFor(r.code)); return; }
    setOpen(false);
    toast.show({ tone: 'success', title: 'Access review recorded.' });
    router.refresh();
  };
  return (
    <main className="lims-page">
      <header className="lims-page-header">
        <h1>Access review</h1>
        {canRecord ? <Button variant="primary" onPress={() => { setFail(null); setOpen(true); }}>Record review completed</Button> : null}
      </header>
      {due ? (
        <div role="alert">
          <Banner tone="warning" title={last ? `Last review: ${fmt(last.reviewed_at)} by ${by}` : 'No access review has been recorded yet.'}>
            <p>Review every user&apos;s roles and centre access at least every 90 days.</p>
          </Banner>
        </div>
      ) : (
        <Banner tone="info" title={`Last review: ${fmt(last!.reviewed_at)} by ${by}`} />
      )}
      <Grid label="Access review" columns={['User', 'Roles', 'Centres', 'MFA', 'Last login', 'Status']}
        rows={users.map((u) => ({
          key: u.membership_id,
          cells: [u.display_name, rolesText(u.roles), u.all_centres ? 'All centres' : String(u.centre_count), u.mfa_enrolled ? 'On' : 'Off',
            <Time key="t" iso={u.last_login_at} label={fmt(u.last_login_at)} />, `${STATUS_LABEL[u.status] ?? u.status}${u.is_locked ? ' · Locked' : ''}`],
        }))} />
      {open ? (
        <Dialog title="Record review completed" isOpen onClose={() => setOpen(false)}
          footer={<><Button variant="ghost" onPress={() => setOpen(false)}>Cancel</Button><Button variant="primary" onPress={() => void submit()} isLoading={busy}>Record review</Button></>}>
          {fail ? <Alert text={fail} /> : null}
          <p>Users reviewed: {users.length}.</p>
          <Field label="Notes" multiline value={notes} onChange={setNotes} error={error} hint="Up to 2000 characters." />
        </Dialog>
      ) : null}
    </main>
  );
}
