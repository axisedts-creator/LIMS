'use client';
// 04-UI-UX §7 Discount approvals inbox (approver side of US-FD-07). Keys: A approve (confirm), R reject (note required). Polls every 10 s
// via router.refresh(). Approve/Reject are UI hints: the API enforces frontdesk.discount.approve, aal2 (auth.mfa_required) and
// self-approval (frontdesk.discount_self_approval_forbidden). Failures close the dialog and show one readable banner.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { approveDiscountAction, rejectDiscountAction } from '../server/actions';
import type { DiscountApproval, DiscountLine } from '../server/types';
import { Ad, MFA_BANNER, NEEDS_APPROVER_ROLE, Status, errorText, formatNpr, hasPerm, humanize, npr } from './format';

type Dlg = { kind: 'approve' | 'reject' | 'details'; a: DiscountApproval };
const POLL_MS = 10_000;
const pct = (bp: number) => `${bp / 100}%`;
const lineValue = (l: DiscountLine) => (l.percent_bp !== undefined ? pct(l.percent_bp) : l.amount ? npr(l.amount) : '—');
// ponytail: the MFA/profile route is owned by C2 and not named in the spec; "/profile" is the placeholder until C2 publishes it.
const PROFILE_HREF = '/profile';

export function DiscountApprovalsInbox({ approvals, permissions, currentMembershipId, centres, mfaRequired = false }: { approvals: readonly DiscountApproval[]; permissions: readonly string[]; currentMembershipId: string; centres: readonly { id: string; name: string }[]; mfaRequired?: boolean }) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const toast = useToast();
  const canApprove = hasPerm(permissions, 'frontdesk.discount.approve');
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [notice, setNotice] = useState<{ title: string; mfa?: boolean }>();
  const [now, setNow] = useState(() => Date.now());
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!canApprove) return;
    const t = setInterval(() => { setNow(Date.now()); routerRef.current.refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [canApprove]);

  if (!canApprove) return <section aria-label="Discount approvals"><PageHeader title="Discount approvals" helpKey="frontdesk.discount_approvals" /><Banner tone="info" title={NEEDS_APPROVER_ROLE} /></section>;

  const centreName = new Map(centres.map((c) => [c.id, c.name]));
  const own = (a: DiscountApproval) => a.requested_by.membership_id === currentMembershipId;
  const arm = (kind: Dlg['kind'], a: DiscountApproval) => { key.current = crypto.randomUUID(); setNotice(undefined); setDlg({ kind, a }); };
  const fail = (code: string, status: number) => {
    setDlg(null);
    setNotice(code === 'auth.mfa_required' ? { title: MFA_BANNER, mfa: true } : { title: errorText(code, status) });
    if (code === 'common.version_conflict') router.refresh();
  };
  const done = (title: string) => { setDlg(null); toast.show({ tone: 'success', title }); router.refresh(); };
  const left = (a: DiscountApproval) => Math.max(0, Math.ceil((Date.parse(a.expires_at) - now) / 60_000));

  const columns: ColumnDef<DiscountApproval>[] = [
    { id: 'requested', header: 'Requested', isRowHeader: true, cell: (a) => (a.status === 'pending' ? <span suppressHydrationWarning>Expires <Ad value={a.expires_at} withTime /> · {left(a)} min left</span> : <Ad value={a.expires_at} withTime />) },
    { id: 'centre', header: 'Centre', cell: (a) => centreName.get(a.centre_id) ?? '—' },
    { id: 'by', header: 'Requested by', cell: (a) => a.requested_by.display_name },
    { id: 'patient', header: 'Patient code', cell: (a) => a.patient_code ?? '—' },
    { id: 'gross', header: 'Gross', align: 'end', cell: (a) => npr(a.gross) },
    { id: 'discount', header: 'Discount', align: 'end', cell: (a) => `${npr(a.computed_discount)} · ${pct(a.percent_of_gross_bp)}` },
    { id: 'reason', header: 'Reason', cell: (a) => (a.reason_text ? `${humanize(a.reason_code)} — ${a.reason_text}` : humanize(a.reason_code)) },
    { id: 'status', header: 'Status', cell: (a) => <Status status={a.status} /> },
    {
      id: 'actions',
      header: 'Actions',
      cell: (a) => (
        <span>
          {a.status === 'pending' && own(a) ? <span>Needs another approver </span> : null}
          {a.status === 'pending' ? <Button size="sm" variant="primary" isDisabled={own(a)} onPress={() => arm('approve', a)}>Approve</Button> : null}
          {a.status === 'pending' ? <Button size="sm" onPress={() => arm('reject', a)}>Reject</Button> : null}
          <Button size="sm" variant="ghost" onPress={() => arm('details', a)}>Details</Button>
        </span>
      ),
    },
  ];

  // A / R on a focused pending row. Capture phase: runs before the grid's type-ahead can move focus.
  const onKeyDownCapture = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if ((k !== 'a' && k !== 'r') || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const a = approvals.find((x) => x.id === t.closest('[data-row-id]')?.getAttribute('data-row-id'));
    if (!a || a.status !== 'pending' || (k === 'a' && own(a))) return;
    e.preventDefault();
    e.stopPropagation();
    arm(k === 'a' ? 'approve' : 'reject', a);
  };

  return (
    <section aria-label="Discount approvals" onKeyDownCapture={onKeyDownCapture}>
      <PageHeader title="Discount approvals" helpKey="frontdesk.discount_approvals" />
      {mfaRequired || notice?.mfa ? <div role="alert"><Banner tone="warning" title={MFA_BANNER}><a className="lims-link" href={PROFILE_HREF}>Open my profile</a></Banner></div> : notice ? <div role="alert"><Banner tone="danger" title={notice.title} /></div> : null}
      {mfaRequired ? null : <DataTable caption="Discount approvals" columns={columns} rows={approvals} getRowId={(a) => a.id} emptyState={{ title: 'No pending approvals' }} />}

      <ConfirmDialog
        key={`approve-${key.current}`}
        title="Approve discount"
        isOpen={dlg?.kind === 'approve'}
        confirmLabel="Approve"
        onCancel={() => setDlg(null)}
        body={dlg ? <p>Approve a discount of {formatNpr(dlg.a.computed_discount.amount_paisa)} ({pct(dlg.a.percent_of_gross_bp)}) requested by {dlg.a.requested_by.display_name}?</p> : null}
        onConfirm={async () => {
          if (dlg?.kind !== 'approve') return;
          const r = await approveDiscountAction(dlg.a.id, dlg.a.version, key.current);
          if (r.ok) done('Discount approved.'); else fail(r.code, r.status);
        }}
      />
      {dlg?.kind === 'reject' ? <RejectDialog a={dlg.a} idempotencyKey={key.current} onClose={() => setDlg(null)} onDone={() => done('Discount rejected.')} onFail={fail} /> : null}
      {dlg?.kind === 'details' ? (
        <Drawer title="Discount details" isOpen onClose={() => setDlg(null)}>
          <ul>
            {dlg.a.discounts.map((l, i) => <li key={i}>{humanize(l.scope)} — {humanize(l.kind)} {lineValue(l)} — {humanize(l.reason_code)}</li>)}
          </ul>
        </Drawer>
      ) : null}
    </section>
  );
}

function RejectDialog({ a, idempotencyKey, onClose, onDone, onFail }: { a: DiscountApproval; idempotencyKey: string; onClose: () => void; onDone: () => void; onFail: (code: string, status: number) => void }) {
  const [note, setNote] = useState('');
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await rejectDiscountAction(a.id, a.version, note.trim(), idempotencyKey);
      if (r.ok) onDone(); else onFail(r.code, r.status);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog title="Reject discount" isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit}>
        <TextField label="Note" name="note" isRequired maxLength={500} value={note} onChange={setNote} />
        <Button type="submit" variant="danger" shortcut="Ctrl+Enter">Reject</Button>
      </Form>
    </Dialog>
  );
}
