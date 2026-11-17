'use client';
// SR-05 review panel (04-UI-UX SR-05): status, "Changes since active version", Approve (#20) / Return to draft (#21). The buttons are UI hints; the API enforces
// smartreport.template.approve and aal2. 403 auth.mfa_required -> "Verify now" (the shell step-up reloads into the session guard); the same request can then be sent again.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { TextArea } from '@lims/ui/components/TextArea';
import { approveAction, returnAction } from '../server/actions';
import { statusText, type Counts, type Diff } from '../library';

const ATTESTATION = 'I have reviewed every text, rule and interval in this library and approve it for patient summaries.';
const APPROVED = 'Approved — this version is now active.';
const NOTE_MAX = 500;
const COMMENT_MAX = 1000;
// [CONV] the inputs accept more than the limit so an over-long paste is reported, not silently cut.
const INPUT_CAP = 3000;

type Notice = { tone: 'success' | 'warning' | 'danger'; title: string; action?: 'verify' | 'reload'; live: 'status' | 'alert' };

function failure(r: { status: number; code: string }): Notice {
  if (r.code === 'auth.mfa_required') return { tone: 'warning', live: 'alert', action: 'verify', title: 'Confirm your identity before you continue. Verify now, then try again.' };
  if (r.status === 409) return { tone: 'warning', live: 'alert', action: 'reload', title: 'This version was changed by someone else or is no longer in review. Reload to see the latest.' };
  if (r.status === 403) return { tone: 'danger', live: 'alert', title: 'You do not have permission to do this.' };
  return { tone: 'danger', live: 'alert', title: 'Could not complete this action. Try again.' };
}

const row = (name: string, c: Counts) => (
  <li key={name}>{name}: {c.added} added, {c.changed} changed, {c.removed} removed</li>
);

interface Props { id: string; status: string; version: number; changeSummary?: string | undefined; diff: Diff; hasActive: boolean; canApprove: boolean }

export function ReviewPanel({ id, status, version, changeSummary, diff, hasActive, canApprove }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<'approve' | 'return'>();
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [settled, setSettled] = useState(false);
  const returning = useRef(false);

  const show = (o: 'approve' | 'return') => { setNote(''); setComment(''); setFieldError(undefined); setNotice(undefined); setOpen(o); };
  const fail = (r: { status: number; code: string }) => { setOpen(undefined); setNotice(failure(r)); };

  const approve = async () => {
    const n = note.trim();
    if (n.length > NOTE_MAX) { setFieldError(`Note must be ${NOTE_MAX} characters or fewer.`); return; }
    const r = await approveAction(id, version, n || undefined);
    if (r.ok) { setOpen(undefined); setSettled(true); setNotice({ tone: 'success', live: 'status', title: APPROVED }); router.refresh(); } else fail(r);
  };

  const giveBack = async () => {
    if (returning.current) return;
    const c = comment.trim();
    if (!c) { setFieldError('Comment is required.'); return; }
    if (c.length > COMMENT_MAX) { setFieldError(`Comment must be ${COMMENT_MAX} characters or fewer.`); return; }
    returning.current = true;
    try {
      const r = await returnAction(id, version, c);
      if (r.ok) { setOpen(undefined); setSettled(true); router.push('/smartreport/library'); } else fail(r);
    } finally { returning.current = false; }
  };

  const act = canApprove && status === 'in_review' && !settled;
  return (
    <div>
      <p>Status: <strong>{statusText(status)}</strong></p>
      {changeSummary ? <p>Change summary: {changeSummary}</p> : null}
      <section aria-labelledby="sr-changes">
        <h2 id="sr-changes">Changes since active version</h2>
        {hasActive ? null : <p>There is no active version yet; every item counts as added.</p>}
        <ul>{row('Texts', diff.texts)}{row('Rules', diff.rules)}{row('Analyte mapping', diff.mapping)}</ul>
      </section>
      {notice ? (
        <div role={notice.live}>
          <Banner
            tone={notice.tone} title={notice.title}
            {...(notice.action === 'verify' ? { action: { label: 'Verify now', onPress: () => window.location.reload() } } : {})}
            {...(notice.action === 'reload' ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})}
          />
        </div>
      ) : null}
      {act ? (
        <span className="lims-inline">
          <Button variant="primary" onPress={() => show('approve')}>Approve</Button>
          <Button onPress={() => show('return')}>Return to draft</Button>
        </span>
      ) : null}
      <ConfirmDialog
        title="Approve this library?" confirmLabel="Approve" isOpen={open === 'approve'} onCancel={() => setOpen(undefined)} onConfirm={approve}
        body={(
          <>
            <p>{ATTESTATION}</p>
            <TextArea label="Note (optional)" name="note" maxLength={INPUT_CAP} showCount={false} value={note} onChange={setNote} {...(fieldError ? { error: fieldError } : {})} />
          </>
        )}
      />
      <Dialog
        title="Return this version to the author?" isOpen={open === 'return'} onClose={() => setOpen(undefined)}
        footer={(
          <>
            <Button variant="ghost" onPress={() => setOpen(undefined)}>Cancel</Button>
            <Button variant="primary" onPress={() => void giveBack()}>Return to draft</Button>
          </>
        )}
      >
        <TextArea label="Comment" name="comment" maxLength={INPUT_CAP} showCount={false} value={comment} onChange={setComment} {...(fieldError ? { error: fieldError } : {})} />
      </Dialog>
    </div>
  );
}
