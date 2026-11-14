'use client';
// 04-UI-UX §8.10 Finance worklist: Credit notes required, Payments to review, Refund approvals (B10a approve / B10b reject with note).
// Own refund requests show "Needs another approver" and Approve is disabled (billing.refund_self_approval_forbidden); the API enforces too.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { approveRefundAction, rejectRefundAction, resolveFinanceReviewItemAction } from '../server/actions';
import type { CreditNoteTask, FinanceReviewItem, RefundRequest } from '../server/types';
import { Ad, errorText, hasPerm, humanize, npr } from './format';

type Tab = 'tasks' | 'review' | 'refunds';
const REVIEW_KIND: Record<string, string> = { home_payment_method_inactive: 'Home-collection payment on an inactive payment method' };
const RESOLUTIONS = [
  { value: 'refunded', label: 'Refunded' },
  { value: 'kept_as_advance', label: 'Kept as advance' },
  { value: 'other', label: 'Other (note required)' },
] as const;

export function FinanceWorklist({ creditNoteTasks, reviewItems, refundRequests, currentMembershipId, permissions }: { creditNoteTasks: readonly CreditNoteTask[]; reviewItems: readonly FinanceReviewItem[]; refundRequests: readonly RefundRequest[]; currentMembershipId: string; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('tasks');
  const [approving, setApproving] = useState<RefundRequest | null>(null);
  const [rejecting, setRejecting] = useState<RefundRequest | null>(null);
  const [resolving, setResolving] = useState<FinanceReviewItem | null>(null);
  const key = useRef(crypto.randomUUID());
  const arm = () => { key.current = crypto.randomUUID(); };
  const canApprove = hasPerm(permissions, 'billing.refund.approve');
  const done = (title: string) => { toast.show({ tone: 'success', title }); router.refresh(); };
  const fail = (code: string, title: string) => toast.show({ tone: 'danger', title, description: errorText(code) });

  const tasks: ColumnDef<CreditNoteTask>[] = [
    { id: 'invoice', header: 'Invoice', isRowHeader: true, cell: (t) => <a className="lims-link" href={`/billing/invoices/${t.invoice_id}`}>Open invoice</a> },
    { id: 'cause', header: 'Cause', cell: (t) => humanize(t.cause) },
    { id: 'lines', header: 'Lines', align: 'end', cell: (t) => String(t.invoice_line_ids.length) },
    { id: 'created', header: 'Created', cell: (t) => <Ad value={t.created_at} withTime /> },
  ];
  const review: ColumnDef<FinanceReviewItem>[] = [
    { id: 'kind', header: 'Kind', isRowHeader: true, cell: (i) => REVIEW_KIND[i.kind] ?? humanize(i.kind) },
    { id: 'amount', header: 'Amount', align: 'end', cell: (i) => npr(i.amount) },
    { id: 'created', header: 'Created', cell: (i) => <Ad value={i.created_at} withTime /> },
    { id: 'actions', header: 'Actions', cell: (i) => (canApprove && i.status === 'open' ? <Button size="sm" onPress={() => { arm(); setResolving(i); }}>Resolve</Button> : null) },
  ];
  const refunds: ColumnDef<RefundRequest>[] = [
    { id: 'requested', header: 'Requested by', isRowHeader: true, cell: (r) => r.requested_by.display_name },
    { id: 'method', header: 'Method', cell: (r) => humanize(r.method_code) },
    { id: 'amount', header: 'Amount', align: 'end', cell: (r) => npr(r.refund_amount) },
    { id: 'reason', header: 'Reason', cell: (r) => humanize(r.reason_code) },
    { id: 'when', header: 'Requested', cell: (r) => <Ad value={r.requested_at} withTime /> },
    {
      id: 'actions',
      header: 'Actions',
      cell: (r) => {
        const own = r.requested_by.membership_id === currentMembershipId;
        return (
          <span>
            {own ? <span>Needs another approver </span> : null}
            <Button size="sm" variant="primary" isDisabled={own || !canApprove} onPress={() => { arm(); setApproving(r); }}>Approve</Button>
            <Button size="sm" isDisabled={!canApprove} onPress={() => { arm(); setRejecting(r); }}>Reject</Button>
          </span>
        );
      },
    },
  ];

  return (
    <section aria-label="Finance worklist">
      <PageHeader title="Finance worklist" helpKey="billing.worklist" />
      <Tabs
        items={[{ id: 'tasks', label: 'Credit notes required' }, { id: 'review', label: 'Payments to review' }, { id: 'refunds', label: 'Refund approvals' }]}
        selectedId={tab}
        onChange={(id) => setTab(id as Tab)}
        aria-label="Worklist"
      >
        {tab === 'tasks' ? <DataTable caption="Credit notes required" columns={tasks} rows={creditNoteTasks} getRowId={(t) => t.id} emptyState={{ title: 'No credit notes are waiting.' }} /> : null}
        {tab === 'review' ? <DataTable caption="Payments to review" columns={review} rows={reviewItems} getRowId={(i) => i.id} emptyState={{ title: 'No payments to review.' }} /> : null}
        {tab === 'refunds' ? <DataTable caption="Refund approvals" columns={refunds} rows={refundRequests} getRowId={(r) => r.id} emptyState={{ title: 'No refund requests are waiting.' }} /> : null}
      </Tabs>

      <ConfirmDialog
        title="Approve refund"
        isOpen={approving !== null}
        confirmLabel="Approve"
        onCancel={() => setApproving(null)}
        body={<p>Approve a refund of {approving ? npr(approving.refund_amount) : ''} requested by {approving?.requested_by.display_name}?</p>}
        onConfirm={async () => {
          if (!approving) return;
          const r = await approveRefundAction(approving.id, approving.version, key.current);
          if (r.ok) { setApproving(null); done('Refund approved.'); } else fail(r.code, 'Could not approve the refund');
        }}
      />
      {rejecting ? <RejectDialog request={rejecting} idempotencyKey={key.current} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); done('Refund rejected.'); }} onFail={(c) => fail(c, 'Could not reject the refund')} /> : null}
      {resolving ? <ResolveDialog item={resolving} idempotencyKey={key.current} onClose={() => setResolving(null)} onDone={() => { setResolving(null); done('Payment resolved.'); }} onFail={(c) => fail(c, 'Could not resolve the payment')} /> : null}
    </section>
  );
}

function RejectDialog({ request, idempotencyKey, onClose, onDone, onFail }: { request: RefundRequest; idempotencyKey: string; onClose: () => void; onDone: () => void; onFail: (code: string) => void }) {
  const [note, setNote] = useState('');
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await rejectRefundAction(request.id, request.version, note.trim(), idempotencyKey);
      if (r.ok) onDone(); else onFail(r.code);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog title="Reject refund" isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit}>
        <TextField label="Note" name="note" isRequired maxLength={500} value={note} onChange={setNote} />
        <Button type="submit" variant="danger" shortcut="Ctrl+Enter">Reject</Button>
      </Form>
    </Dialog>
  );
}

function ResolveDialog({ item, idempotencyKey, onClose, onDone, onFail }: { item: FinanceReviewItem; idempotencyKey: string; onClose: () => void; onDone: () => void; onFail: (code: string) => void }) {
  const [code, setCode] = useState<'refunded' | 'kept_as_advance' | 'other'>();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    if (!code) return setError('Choose how to resolve this payment.');
    if (code === 'other' && !note.trim()) return setError('Add a note.');
    inFlight.current = true;
    try {
      const r = await resolveFinanceReviewItemAction(item.id, item.version, { resolution_code: code, ...(note.trim() ? { note: note.trim() } : {}) }, idempotencyKey);
      if (r.ok) onDone(); else onFail(r.code);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog title="Resolve payment" isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit}>
        {error ? <p role="alert">{error}</p> : null}
        <Select label="Resolution" name="resolution_code" isRequired options={RESOLUTIONS} {...(code ? { value: code } : {})} onChange={(v) => { setCode(v as typeof code); setError(undefined); }} />
        <TextField label="Note" name="note" maxLength={500} value={note} onChange={setNote} />
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Resolve</Button>
      </Form>
    </Dialog>
  );
}
