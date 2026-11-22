'use client';
// AD-15 Access review (US-G1; T0D-BUILD-3, LD-447): review banner (warning when > 90 days or none); history of reviews (listAccessReviews, newest
// first as the API answers); [Record review completed] (recordAccessReview) with the count of ACTIVE memberships prefilled; the membership table.
// The reviewer and tenant are the server's (from the session), never sent. Deliberately no export control on this screen.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import { recordAccessReview } from '../actions';
import { Grid, Time } from '../Grid';
import { Alert, Field } from '../ui';
import { DAY_MS, STATUS_LABEL, copyFor, fmt, rolesText, shortId, type Review, type UserSummary } from '../lib';

const COUNT_MAX = 100_000;   // AccessReviewCreateRequest.memberships_reviewed maximum
const NOTES_MAX = 2000;

export function AccessReview({ users, reviews, canRecord, now }: { users: UserSummary[]; reviews: Review[]; canRecord: boolean; now: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{ count?: string; notes?: string }>({});
  const [fail, setFail] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);   // a double click sends ONE request (state updates land too late)
  const nameOf = (m: string) => users.find((u) => u.membership_id === m)?.display_name ?? shortId(m);
  const last = reviews[0] ?? null;
  const due = !last || now - Date.parse(last.reviewed_at) > 90 * DAY_MS;
  const start = () => { setFail(null); setErrors({}); setCount(String(users.length)); setNotes(''); setOpen(true); };
  const submit = async () => {
    if (sending.current) return;
    const e: { count?: string; notes?: string } = {};
    const n = /^\d+$/.test(count.trim()) ? Number(count.trim()) : NaN;
    if (!(n >= 0 && n <= COUNT_MAX)) e.count = `Enter a whole number from 0 to ${COUNT_MAX}.`;
    if (notes.length > NOTES_MAX) e.notes = `Use ${NOTES_MAX} characters or fewer.`;
    setErrors(e);
    if (e.count || e.notes) return;
    sending.current = true;
    setBusy(true);
    setFail(null);
    const r = await recordAccessReview(n, notes.trim() || undefined);
    sending.current = false;
    setBusy(false);
    if (!r.ok) { setFail({ text: `Could not record the review. ${copyFor(r.code)}`, requestId: r.requestId }); return; }
    setOpen(false);
    toast.show({ tone: 'success', title: 'Access review recorded.' });
    router.refresh();
  };
  return (
    <main className="lims-page">
      <PageHeader title="Access review" helpKey="admin.access-review"
        {...(canRecord ? { actions: <Button onPress={start} variant="primary">Record review completed</Button> } : {})} />
      {due ? (
        <div role="alert">
          <Banner tone="warning" title={last ? `Last review: ${fmt(last.reviewed_at)} by ${nameOf(last.reviewed_by_membership_id)}` : 'No access review has been recorded yet.'}>
            <p>Review every user&apos;s roles and centre access at least every 90 days.</p>
          </Banner>
        </div>
      ) : (
        <Banner tone="info" title={`Last review: ${fmt(last!.reviewed_at)} by ${nameOf(last!.reviewed_by_membership_id)}`} />
      )}
      <Grid label="Access reviews" columns={['Date', 'Reviewer', 'Memberships reviewed', 'Notes']} empty="No access reviews recorded yet."
        rows={reviews.map((r) => ({
          key: r.access_review_id,
          cells: [<Time key="t" iso={r.reviewed_at} label={fmt(r.reviewed_at)} />, nameOf(r.reviewed_by_membership_id), String(r.memberships_reviewed), r.notes ?? '—'],
        }))} />
      <Grid label="Active users" columns={['User', 'Roles', 'Centres', 'MFA', 'Last login', 'Status']} empty="No active users."
        rows={users.map((u) => ({
          key: u.membership_id,
          cells: [u.display_name, rolesText(u.roles), u.all_centres ? 'All centres' : String(u.centre_count), u.mfa_enrolled ? 'On' : 'Off',
            <Time key="t" iso={u.last_login_at} label={fmt(u.last_login_at)} />, `${STATUS_LABEL[u.status] ?? u.status}${u.is_locked ? ' · Locked' : ''}`],
        }))} />
      {open ? (
        // [CONV] not dismissable: typed notes are not lost to an outside click; Cancel is the one way out (no second close control)
        <Dialog title="Record review completed" isOpen isDismissable={false} onClose={() => setOpen(false)}
          footer={<><Button onPress={() => setOpen(false)} variant="ghost">Cancel</Button><Button onPress={() => void submit()} isLoading={busy} variant="primary">Record review</Button></>}>
          {fail ? <Alert text={fail.text} requestId={fail.requestId} /> : null}
          <Field label="Memberships reviewed" type="number" inputMode="numeric" value={count} onChange={setCount} error={errors.count}
            hint={`Active memberships now: ${users.length}.`} required />
          <Field label="Notes" multiline value={notes} onChange={setNotes} error={errors.notes} hint={`Up to ${NOTES_MAX} characters.`} />
        </Dialog>
      ) : null}
    </main>
  );
}
