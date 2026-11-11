'use client';
// 04-UI-UX §2.3 Gateway refunds. Plain-JSON rows from the server page; every action calls a server action (the token stays on the server).
// Status is text + tone. Two-person rule: Approve is disabled on your own request (the server decides again). Nothing here claims a refund is done before the server says `completed`.
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { SECOND_PERSON, failText } from '../errors';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { dayNpt, dayOfInstant, gatewayLabel, hasPerm, humanize, kitMoney, nprText, refundStatus } from '../labels';
import {
  approveRefundAction, confirmRefundAction, failRefundAction, recheckRefundAction, rejectRefundAction, type ActionResult,
} from '../server/actions';
import type { PaymentMoney, RefundCodes, RefundDto } from '../types';

/** Standalone amount via kit MoneyText (04-UI-UX:21); em dash when absent. */
const amt = (m: PaymentMoney | undefined) => { const k = kitMoney(m); return k ? <MoneyText value={k} /> : <span className="lims-money">—</span>; };

type Iso = DateTextProps['value'];
type Fail = Extract<ActionResult, { ok: false }>;
const ALL = 'all';
const BASE = '/payments/refunds';
const REF = /^[A-Za-z0-9_.:/-]{1,100}$/;
const OPEN_STATES = ['requested', 'held_for_review'];
const STATUS_OPTIONS = ['pending_approval', 'approved', 'requested', 'held_for_review', 'completed', 'failed', 'rejected'].map((s) => ({ value: s, label: refundStatus(s)[1] }));
const GATEWAY_OPTIONS = [{ value: ALL, label: 'All' }, { value: 'esewa', label: 'eSewa' }, { value: 'khalti', label: 'Khalti' }];

export interface RefundsFilter { status: readonly string[]; gateway?: string; created?: readonly [string, string] }
export interface RefundsListProps {
  refunds: readonly RefundDto[];
  permissions: readonly string[];
  currentMembershipId?: string | undefined;
  codes: RefundCodes;
  /** Tenant two-person threshold (paisa): an own request at or below it may be approved by its requester. Absent / 0 = always two people. */
  thresholdPaisa?: number | undefined;
  filter?: RefundsFilter;
  nextCursor?: string;
  hasPrevious?: boolean;
}
type Kind = 'approve' | 'reject' | 'fail' | 'confirm';
interface Dlg { kind: Kind; refund: RefundDto; key: string }

export function RefundsList({ refunds, permissions, currentMembershipId, codes, thresholdPaisa, filter, nextCursor, hasPrevious }: RefundsListProps) {
  const router = useRouter();
  const toast = useToast();
  const canApprove = hasPerm(permissions, 'payments.refund.approve');
  const canRecheck = hasPerm(permissions, 'payments.intent.resolve');
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [note, setNote] = useState('');
  const [needText, setNeedText] = useState(false);
  const [banner, setBanner] = useState('');
  const busy = useRef(false);
  const holdName = new Map(codes.refund_hold_reasons.map((r) => [r.code, r.display]));

  const open = (kind: Kind, refund: RefundDto) => {
    setNote('');
    setNeedText(false);
    setBanner('');
    setDlg({ kind, refund, key: globalThis.crypto.randomUUID() }); // one idempotency key per opened dialog
  };
  const close = () => { setDlg(null); setNeedText(false); };
  const fail = (r: Fail, refund: RefundDto, kind?: Kind) =>
    setBanner(kind === 'fail' && r.code === 'payments.refund_not_allowed' ? `${gatewayLabel(refund.gateway)} shows a refund for this payment. Use Re-check instead.` : failText(r));
  const done = (title: string) => { toast.show({ tone: 'info', title }); router.refresh(); };

  const recheck = async (r: RefundDto) => {
    if (busy.current || !canRecheck) return;
    busy.current = true;
    setBanner('');
    try {
      const res = await recheckRefundAction(r.id);
      if (res.ok) done(`Checked with ${gatewayLabel(res.gateway ?? r.gateway)}: ${refundStatus(res.status ?? r.status)[1]}`);
      else if (res.status === 429) toast.show({ tone: 'info', title: failText(res) });
      else fail(res, r);
    } finally {
      busy.current = false;
    }
  };

  const approve = async (d: Dlg) => {
    const res = await approveRefundAction(d.refund.id, d.refund.version, note.trim() || undefined, d.key);
    close();
    if (res.ok) done('Refund approved.');
    else fail(res, d.refund, 'approve');
  };
  const reject = async (d: Dlg, r: { reasonCode?: string; reasonText?: string }) => {
    const picked = codes.refund_reject_reasons.find((x) => x.code === r.reasonCode);
    if (!r.reasonCode || (picked?.requires_text && !r.reasonText?.trim())) { setNeedText(true); return; }
    const res = await rejectRefundAction(d.refund.id, d.refund.version, r.reasonCode, r.reasonText, d.key);
    close();
    if (res.ok) done('Refund rejected.');
    else fail(res, d.refund, 'reject');
  };
  const markFailed = async (d: Dlg, r: { reasonCode?: string; reasonText?: string }) => {
    const picked = codes.refund_fail_reasons.find((x) => x.code === r.reasonCode);
    if (!r.reasonCode || (picked?.requires_text && !r.reasonText?.trim())) { setNeedText(true); return; }
    const res = await failRefundAction(d.refund.id, d.refund.version, r.reasonCode, r.reasonText, d.key);
    close();
    if (res.ok) done('Refund marked as failed.');
    else fail(res, d.refund, 'fail');
  };

  const isOwn = (r: RefundDto) => !!currentMembershipId && r.requested_by?.membership_id === currentMembershipId;
  const ownAllowed = (r: RefundDto) => thresholdPaisa !== undefined && thresholdPaisa > 0 && r.amount.amount_paisa <= thresholdPaisa;

  const actions = (r: RefundDto) => (
    <div className="lims-row-actions">
      {canApprove && r.status === 'pending_approval' ? (
        <>
          {isOwn(r) && !ownAllowed(r) ? (
            <SecondPersonHint />
          ) : (
            <Button size="sm" variant="primary" onPress={() => open('approve', r)}>Approve</Button>
          )}
          <Button size="sm" variant="danger" onPress={() => open('reject', r)}>Reject</Button>
        </>
      ) : null}
      {canApprove && OPEN_STATES.includes(r.status) && r.mode !== 'api' ? <Button size="sm" variant="primary" onPress={() => open('confirm', r)}>Confirm refund done</Button> : null}
      {canRecheck && OPEN_STATES.includes(r.status) ? <Button size="sm" onPress={() => void recheck(r)}>Re-check</Button> : null}
      {canApprove && OPEN_STATES.includes(r.status) ? <Button size="sm" variant="danger" onPress={() => open('fail', r)}>Mark refund failed</Button> : null}
    </div>
  );

  const columns: ColumnDef<RefundDto>[] = [
    { id: 'requested', header: 'Requested', isRowHeader: true, cell: (r) => <DateText value={r.requested_at as Iso} withTime /> },
    { id: 'gateway', header: 'Gateway', cell: (r) => gatewayLabel(r.gateway) },
    { id: 'amount', header: 'Amount', align: 'end', cell: (r) => amt(r.amount) },
    { id: 'status', header: 'Status', cell: (r) => { const [tone, label] = refundStatus(r.status); return <StatusChip kind="generic" status={r.status} tone={tone} label={label} />; } },
    { id: 'mode', header: 'Mode', cell: (r) => (r.mode === 'api' ? 'Provider API' : 'Manual') },
    { id: 'requested_by', header: 'Requested by', cell: (r) => r.requested_by?.display_name || '—' },
    { id: 'approved_by', header: 'Approved by', cell: (r) => r.approved_by?.display_name || '—' },
    { id: 'reason', header: 'Reason under review', cell: (r) => (r.held_reason ? holdName.get(r.held_reason) ?? humanize(r.held_reason) : '—') },
    { id: 'intent', header: 'Intent', cell: (r) => <a href={`/payments/intents/${r.intent_id}`} aria-label={`Payment ${r.intent_id.slice(0, 8)}`}><IdText value={r.intent_id} /></a> },
    { id: 'actions', header: 'Actions', cell: actions },
  ];

  const f: RefundsFilter = filter ?? { status: [] };
  const filters: FilterDef[] = [
    { id: 'status', label: 'Status', kind: 'select', multiple: true, options: STATUS_OPTIONS },
    { id: 'gateway', label: 'Gateway', kind: 'select', options: GATEWAY_OPTIONS },
    { id: 'created', label: 'Created', kind: 'date_range' },
  ];
  const value: FilterValue = { status: f.status, gateway: f.gateway ?? ALL, ...(f.created?.[0] && f.created[1] ? { created: [f.created[0], f.created[1]] } : {}) };
  const go = (v: FilterValue, cursor?: string) => {
    const p = new URLSearchParams();
    const one = (k: string, x: string | readonly string[] | undefined) => { const j = typeof x === 'string' ? x : x?.join(','); if (j && j !== ALL) p.set(k, j); };
    one('status', v['status']); one('gateway', v['gateway']);
    const c = v['created'];
    if (Array.isArray(c) && c.length === 2) { p.set('created_at_from', String(c[0])); p.set('created_at_to', String(c[1])); }
    if (cursor) p.set('cursor', cursor);
    const s = p.toString();
    router.push(s ? `${BASE}?${s}` : BASE);
  };

  const gw = dlg ? gatewayLabel(dlg.refund.gateway) : '';
  const needTextNote = needText ? <p role="alert" className="lims-error">Enter details for this reason.</p> : null;
  return (
    <>
      <PageHeader title="Gateway refunds" helpKey="payments.refunds" />
      {banner ? <div role="alert"><Banner tone="danger" title={banner} /></div> : null}
      <FilterBar filters={filters} value={value} onChange={go} onReset={() => router.push(BASE)} />
      <DataTable<RefundDto>
        columns={columns} rows={refunds} getRowId={(r) => r.id} density="compact" caption="Gateway refunds"
        emptyState={{ title: 'No refunds.', body: 'Refund requests appear here until they are completed.' }}
        {...(nextCursor || hasPrevious ? { page: { hasNext: !!nextCursor, hasPrevious: !!hasPrevious, onNext: () => nextCursor && go(value, nextCursor), onPrevious: () => router.back(), limit: 50 } } : {})}
      />
      {dlg?.kind === 'approve' ? (
        <ConfirmDialog
          key={dlg.key} isOpen title={`Approve refund of ${nprText(dlg.refund.amount)}?`} confirmLabel="Approve" onCancel={close} onConfirm={() => approve(dlg)}
          body={
            <>
              <p>{dlg.refund.mode === 'api' ? `The refund will be sent to ${gw} automatically.` : `Refund the patient in the ${gw} merchant dashboard, then confirm here.`}</p>
              <TextField label="Note (optional)" name="note" maxLength={500} value={note} onChange={setNote} />
            </>
          }
        />
      ) : null}
      {dlg?.kind === 'reject' ? (
        <ConfirmDialog
          key={dlg.key} isOpen tone="danger" title={`Reject refund of ${nprText(dlg.refund.amount)}?`} confirmLabel="Reject" onCancel={close} onConfirm={(r) => reject(dlg, r)}
          body={<><p>The refund request is closed and nothing is paid back.</p>{needTextNote}</>}
          requireReason={{ codedSet: 'payments.refund_reject_reasons', options: codes.refund_reject_reasons, freeText: { maxLength: 500, isRequired: false } }}
        />
      ) : null}
      {dlg?.kind === 'fail' ? (
        <ConfirmDialog
          key={dlg.key} isOpen tone="danger" title="Mark this refund as failed?" confirmLabel="Mark refund failed" onCancel={close} onConfirm={(r) => markFailed(dlg, r)}
          body={<><p>{`We check with ${gw} first. Only do this if ${gw} confirmed that no refund was made. No ledger entry is written, and a new refund can be requested.`}</p>{needTextNote}</>}
          requireReason={{ codedSet: 'payments.refund_fail_reasons', options: codes.refund_fail_reasons, freeText: { maxLength: 500, isRequired: false } }}
        />
      ) : null}
      {dlg?.kind === 'confirm' ? (
        <ConfirmManualDialog
          key={dlg.key} refund={dlg.refund} idempotencyKey={dlg.key} onClose={close}
          onDone={(res) => {
            close();
            if (!res.ok) { fail(res, dlg.refund, 'confirm'); return; }
            const g = gatewayLabel(res.gateway ?? dlg.refund.gateway);
            if (res.status === 'completed') toast.show({ tone: 'success', title: `Refund confirmed by ${g} and recorded.` });
            else if (res.status === 'held_for_review') toast.show({ tone: 'warning', title: `${g} does not show this refund yet. We will check again tonight.` });
            else toast.show({ tone: 'info', title: 'Refund updated.' });
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** A disabled Approve on your own request, with the reason shown on hover and keyboard focus (Esc hides it). Own handlers instead of the kit Tooltip: that one
 *  ignores the first pointer event of a session, so the reason could be missing for the very first hover. */
function SecondPersonHint() {
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <span
      tabIndex={0} {...(show ? { 'aria-describedby': id } : {})} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onFocus={() => setShow(true)}
      onBlur={() => setShow(false)} onKeyDown={(e) => { if (e.key === 'Escape') setShow(false); }}
    >
      <Button size="sm" variant="primary" isDisabled>Approve</Button>
      {show ? <span id={id} role="tooltip" className="lims-tooltip">{SECOND_PERSON}</span> : null}
    </span>
  );
}

/** §2.3.2: the provider reference and the day the money was paid back (never after today, never before approval). */
function ConfirmManualDialog({ refund, idempotencyKey, onClose, onDone }: { refund: RefundDto; idempotencyKey: string; onClose: () => void; onDone: (r: ActionResult) => void }) {
  const [ref, setRef] = useState('');
  const [date, setDate] = useState<IsoDate>();
  const [errs, setErrs] = useState<{ ref?: string; date?: string }>({});
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const min = (refund.approved_at ? dayOfInstant(refund.approved_at) : undefined) as IsoDate | undefined;
  const max = dayNpt() as IsoDate;

  const submit = async () => {
    if (inFlight.current) return;
    const e = { ...(REF.test(ref) ? {} : { ref: 'Enter the provider refund reference (letters, numbers and _ . : / - only)' }), ...(date ? {} : { date: 'Enter the date the refund was made' }) };
    setErrs(e);
    if (e.ref || e.date || !date) return;
    inFlight.current = true;
    setPending(true);
    try {
      onDone(await confirmRefundAction(refund.id, refund.version, ref, date, idempotencyKey));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title="Confirm refund done" isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose} isDisabled={pending}>Cancel</Button><Button variant="primary" isLoading={pending} onPress={() => void submit()}>Confirm refund</Button></>}
    >
      <p>{`Enter the reference ${gatewayLabel(refund.gateway)} gave for the refund and the day it was made. We check it with ${gatewayLabel(refund.gateway)} before recording it.`}</p>
      <TextField label="Provider refund reference" name="gateway_refund_reference" maxLength={100} isRequired value={ref} onChange={setRef} {...(errs.ref ? { error: errs.ref } : {})} />
      <DatePicker label="Refunded on" name="refunded_on" isRequired max={max} {...(min ? { min } : {})} {...(date ? { value: date } : {})} onChange={setDate} {...(errs.date ? { error: errs.date } : {})} />
    </Dialog>
  );
}
