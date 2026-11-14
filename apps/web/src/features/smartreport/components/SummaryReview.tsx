'use client';
// SR-02 Summary review (04-UI-UX SR-02; 03-APP-FLOW §2.6). Approve (#31) / Reject (#32) go through server actions; the buttons are UI hints, the API enforces
// smartreport.summary.approve and aal2. Text nodes only (REQ-SEC-088). LD-140: kit components and tokens only.
// [CONV] "Approve & next" approves, then opens the queue (SR-01). "Rebuild with active library" and "Rephrase with AI" belong to other tasks (T29 / Phase 3).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { FlagBadge, type FlagBadgeProps } from '@lims/ui/components/FlagBadge';
import { Grid } from '@lims/ui/components/Grid';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { Timeline } from '@lims/ui/components/Timeline';
import { TimeSeriesChart } from '@lims/ui/components/TimeSeriesChart';
import { approveSummaryAction, rejectSummaryAction } from '../server/summary-actions';
import { STATUS, type InputRow, type SummaryVM } from '../summary-review';

const QUEUE = '/smartreport/summaries';
const ATTESTATION = 'I have read every sentence and confirm it is appropriate for this patient.';
const APPROVED = 'Approved. The PDF report will include this summary the next time it is generated. Use Regenerate on the report screen to add it now.';
const SUPERSEDED = 'Results changed after this summary was built. A new summary will be prepared.';
const COMMENT_MAX = 500;
// [CONV] the input accepts more than the limit so an over-long paste is reported, not silently cut (same as the SR-05 note).
const INPUT_CAP = 3000;

type Iso = DateTextProps['value'];
type Notice = { tone: 'warning' | 'danger'; title: string; action?: 'verify' | 'reload'; queue?: boolean };

function failure(r: { status: number; code: string }): Notice {
  if (r.code === 'smartreport.summary_superseded') return { tone: 'warning', title: SUPERSEDED, queue: true };
  if (r.code === 'auth.mfa_required') return { tone: 'warning', action: 'verify', title: 'Confirm your identity before you continue. Verify now, then try again.' };
  if (r.code === 'smartreport.summary_invalid_transition') return { tone: 'warning', action: 'reload', title: 'This summary was already approved or rejected, or it is no longer waiting for review. Reload to see the latest.' };
  if (r.status === 409) return { tone: 'warning', action: 'reload', title: 'This summary was changed by someone else. Reload to see the latest.' };
  if (r.status === 403) return { tone: 'danger', title: 'You do not have permission to do this.' };
  return { tone: 'danger', title: 'Could not complete this action. Try again.' };
}

export function SummaryReview({ vm }: { vm: SummaryVM }) {
  const router = useRouter();
  const [open, setOpen] = useState<'approve' | 'reject'>();
  const [thenNext, setThenNext] = useState(false);
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const [commentError, setCommentError] = useState<string>();
  const [outcome, setOutcome] = useState<{ status: 'approved' | 'rejected' | 'superseded'; reason?: string }>();
  const [notice, setNotice] = useState<Notice>();

  const status = outcome?.status ?? vm.status;
  const rejectReason = outcome?.reason ?? vm.rejectReason;
  const canAct = vm.canApprove && status === 'draft';
  const [statusLabel, statusTone] = STATUS[status] ?? [status, 'neutral' as const];

  const askApprove = (next: boolean) => { setNotice(undefined); setThenNext(next); setOpen('approve'); };
  const askReject = () => { setNotice(undefined); setReason(undefined); setComment(''); setReasonError(undefined); setCommentError(undefined); setOpen('reject'); };

  useEffect(() => {
    if (!canAct) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'enter') { e.preventDefault(); askApprove(e.shiftKey); } else if (k === 'r' && e.shiftKey) { e.preventDefault(); askReject(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canAct]);

  const fail = (r: { status: number; code: string }) => {
    setOpen(undefined); setNotice(failure(r));
    if (r.code === 'smartreport.summary_superseded') setOutcome({ status: 'superseded' });
    // Only version_conflict auto-refreshes (03-APP-FLOW E13); superseded/invalid_transition bump version, and the
    // page keys on vm.version, so a refresh would remount and wipe the banner (T19 review item 1).
    if (r.code === 'common.version_conflict') router.refresh();
  };

  const approve = async () => {
    const r = await approveSummaryAction(vm.id, vm.version);
    if (!r.ok) { fail(r); return; }
    setOpen(undefined); setNotice(undefined); setOutcome({ status: 'approved' });
    if (thenNext) router.push(QUEUE); else router.refresh();
  };

  const reject = async () => {
    const c = comment.trim();
    if (!reason) { setReasonError('Reason is required.'); return; }
    if (reason === 'other' && !c) { setCommentError('Comment is required when the reason is Other.'); return; }
    if (c.length > COMMENT_MAX) { setCommentError(`Comment must be ${COMMENT_MAX} characters or fewer.`); return; }
    const r = await rejectSummaryAction(vm.id, vm.version, reason, c || undefined);
    if (!r.ok) { fail(r); return; }
    setOpen(undefined); setNotice(undefined); setOutcome({ status: 'rejected', reason: vm.reasons.find((x) => x.code === reason)?.display ?? reason.replace(/_/g, ' ') });
    router.refresh();
  };

  const columns: ColumnDef<InputRow>[] = [
    { id: 'analyte', header: 'Analyte', isRowHeader: true, cell: (r) => r.analyte },
    { id: 'result', header: 'Result', cell: (r) => <>{r.result} {r.flag ? <FlagBadge flag={r.flag as FlagBadgeProps['flag']} /> : null}</> },
    { id: 'unit', header: 'Unit', cell: (r) => r.unit },
    { id: 'range', header: 'Reference range', cell: (r) => r.range },
    { id: 'band', header: 'Band', cell: (r) => <StatusChip kind="generic" status={r.band} label={r.band} tone={r.bandTone} /> },
    { id: 'group', header: 'Group', cell: (r) => r.group },
  ];

  return (
    <div>
      <PageHeader
        title="Smart summary" helpKey="smartreport.summary"
        breadcrumbs={[{ label: 'Smart summaries', href: QUEUE }, { label: 'Smart summary' }]}
        status={<StatusChip kind="generic" status={status} label={statusLabel} tone={statusTone} />}
        actions={canAct ? (
          <>
            <Button variant="primary" shortcut="Ctrl+Enter" onPress={() => askApprove(false)}>Approve</Button>
            <Button variant="danger" shortcut="Ctrl+Shift+R" onPress={askReject}>Reject</Button>
            <Button shortcut="Ctrl+Shift+Enter" onPress={() => askApprove(true)}>Approve &amp; next</Button>
          </>
        ) : null}
      />
      <Stack gap={4}>
        <DescriptionList columns={3} items={[
          { term: 'Registration no.', value: vm.registrationNo }, { term: 'Patient', value: vm.patient }, { term: 'Centre', value: vm.centre },
          { term: 'Built', value: vm.builtAt ? <DateText value={vm.builtAt as Iso} withTime /> : '—' }, { term: 'Library', value: vm.library }, { term: 'Formula', value: vm.formula },
        ]} />
        {status === 'approved' ? (
          <div role="status">
            <Banner tone="success" title={APPROVED}>
              {vm.canResults && vm.orderId ? <a href={`/lab/orders/${vm.orderId}/results`}>Open order results</a> : null}
            </Banner>
          </div>
        ) : null}
        {status === 'superseded' && !notice ? (
          <Banner tone="info" title="This summary was replaced because the results changed.">
            {vm.supersededBy ? <a href={`${QUEUE}/${vm.supersededBy}`}>Replaced by a newer summary</a> : null}
          </Banner>
        ) : null}
        {status === 'rejected' && rejectReason ? <p>Reason for rejection: {rejectReason}</p> : null}
        {notice ? (
          <div role="alert">
            <Banner
              tone={notice.tone} title={notice.title}
              {...(notice.action === 'verify' ? { action: { label: 'Verify now', onPress: () => window.location.reload() } } : {})}
              {...(notice.action === 'reload' ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})}
            >
              {notice.queue ? <a href={QUEUE}>Back to the review queue</a> : null}
            </Banner>
          </div>
        ) : null}

        <Grid columns={vm.inputs ? 2 : 1} gap={4}>
          <section aria-labelledby="sr-preview">
            <h2 id="sr-preview">What the patient will see</h2>
            <Stack gap={3}>
              {vm.score ? (
                <Card title="Health score">
                  <p>{vm.score.value}{vm.score.band ? ` — ${vm.score.band}` : ''}</p>
                  {vm.score.explanation ? <p>{vm.score.explanation}</p> : null}
                </Card>
              ) : null}
              {vm.panels.length ? <ul aria-label="Body systems">{vm.panels.map((p, i) => <li key={i}>{p.name}: {p.status}</li>)}</ul> : null}
              {vm.deranged.length ? <ul aria-label="Results outside the reference range">{vm.deranged.map((t, i) => <li key={i}>{t}</li>)}</ul> : null}
              {vm.trends.map((t) => (
                <TimeSeriesChart key={t.id} title={t.title} series={[{ id: t.id, label: t.title, points: t.points }]} {...(t.unit ? { unit: t.unit } : {})} {...(t.band ? { referenceBand: t.band } : {})} />
              ))}
              {vm.advice.length ? <ul aria-label="Advice">{vm.advice.map((t, i) => <li key={i}>{t}</li>)}</ul> : null}
              {vm.followUps.length ? <ul aria-label="Follow-up">{vm.followUps.map((t, i) => <li key={i}>{t}</li>)}</ul> : null}
              {vm.disclaimer ? <p>{vm.disclaimer}</p> : null}
            </Stack>
          </section>
          {vm.inputs ? (
            <section aria-labelledby="sr-inputs">
              <h2 id="sr-inputs">Results used</h2>
              <p>Approved results this summary was built from</p>
              <DataTable<InputRow>
                columns={columns} rows={vm.inputs} getRowId={(r) => r.id} density="compact" caption="Results used"
                emptyState={{ title: 'No results.' }}
              />
              <DescriptionList items={[
                { term: 'Not mapped', value: `${vm.unmapped ?? 0} approved results are not mapped to a body system and are not in this summary` },
                { term: 'Ignored duplicates', value: String(vm.duplicates ?? 0) },
              ]} />
            </section>
          ) : null}
        </Grid>

        <section aria-labelledby="sr-history">
          <h2 id="sr-history">History</h2>
          <Timeline items={vm.history} />
        </section>
      </Stack>

      <ConfirmDialog
        title="Approve this summary?" confirmLabel="Approve" isOpen={open === 'approve'} onCancel={() => setOpen(undefined)} onConfirm={approve}
        body={<p>{ATTESTATION}</p>}
      />
      <ConfirmDialog
        title="Reject this summary?" confirmLabel="Reject" tone="danger" isOpen={open === 'reject'} onCancel={() => setOpen(undefined)} onConfirm={reject}
        body={(
          <>
            <Select
              label="Reason" name="reason_code" isRequired options={vm.reasons.map((r) => ({ value: r.code, label: r.display }))}
              {...(reason ? { value: reason } : {})} {...(reasonError ? { error: reasonError } : {})}
              onChange={(v) => { setReason(v); setReasonError(undefined); }}
            />
            <TextArea
              label="Comment" name="comment" maxLength={INPUT_CAP} showCount={false} value={comment}
              {...(commentError ? { error: commentError } : {})} onChange={(v) => { setComment(v); setCommentError(undefined); }}
            />
          </>
        )}
      />
    </div>
  );
}
