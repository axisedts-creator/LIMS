'use client';
// 04-UI-UX §2.3 Gateway refunds. Plain-JSON rows from the server page; every action calls a server action (the token stays on the server).
// Status is text + tone. Two-person rule: Approve is disabled on your own request (the server decides again). Nothing here claims a refund is done before the server says `completed`.
// T0D-UICONSOLE-1 (LD-353 template 2 CONSOLE): PageHeader, the same FilterBar, StatTiles (Pending approval, With provider, Oldest age pending approval) above a SplitConsole:
// queue at left (Age first, API order), detail at right (the columns the table had plus History), sticky bar = the row actions the table had (same gates, same dialogs).
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SplitConsole } from '@lims/ui/components/SplitConsole';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { t } from '@/core/i18n/messages';
import { Facts, History, ShortcutKey, hhmm, itemProps, oldest, useNow } from './consoleParts';
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
const WITH_PROVIDER = ['approved', 'requested', 'held_for_review'];
const HEADERS = ['Age', 'Requested', 'Gateway', 'Amount', 'Status'];
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

  // T0D-UICONSOLE-1: the row actions the table had, same gates, now for the selected refund in the sticky bar; the first one carries its shortcut letter.
  type Act = { key: string; label: string; variant?: 'secondary' | 'danger'; run: () => void; blocked?: boolean };
  const actsOf = (r: RefundDto): Act[] => [
    ...(canApprove && r.status === 'pending_approval'
      ? [{ key: 'A', label: 'Approve', variant: 'secondary' as const, run: () => open('approve', r), blocked: isOwn(r) && !ownAllowed(r) }, { key: 'R', label: 'Reject', variant: 'danger' as const, run: () => open('reject', r) }]
      : []),
    ...(canApprove && OPEN_STATES.includes(r.status) && r.mode !== 'api' ? [{ key: 'C', label: 'Confirm refund done', variant: 'secondary' as const, run: () => open('confirm', r) }] : []),
    ...(canRecheck && OPEN_STATES.includes(r.status) ? [{ key: 'R', label: 'Re-check', run: () => void recheck(r) }] : []),
    ...(canApprove && OPEN_STATES.includes(r.status) ? [{ key: 'M', label: 'Mark refund failed', variant: 'danger' as const, run: () => open('fail', r) }] : []),
  ];
  const actions = (r: RefundDto) => (
    <div className="lims-row-actions">
      {actsOf(r).map((a, i) => {
        const label = i === 0 ? `${a.label} (${a.key})` : a.label;
        return a.blocked
          ? <SecondPersonHint key={a.label} label={label} />
          : <Button key={a.label} size="sm" {...(a.variant ? { variant: a.variant } : {})} onPress={a.run}>{label}</Button>;
      })}
    </div>
  );
  const [selectedId, setSelectedId] = useState<string>();
  const now = useNow();
  const sel = refunds.find((r) => r.id === selectedId);
  const first = sel ? actsOf(sel)[0] : undefined;
  const age = (r: RefundDto) => now - Date.parse(r.requested_at);
  const pending = refunds.filter((r) => r.status === 'pending_approval');
  const statusChip = (r: RefundDto) => { const [tone, label] = refundStatus(r.status); return <StatusChip kind="generic" status={r.status} tone={tone} label={label} />; };

  const list = (
    <div className="lims-data-table"><div className="lims-table-scroll">
      <table className="lims-table">
        <caption className="lims-visually-hidden">Gateway refunds</caption>
        <thead><tr>{HEADERS.map((h) => <th key={h} scope="col" {...(h === 'Amount' ? { className: 'lims-align-end' } : {})}>{h}</th>)}</tr></thead>
        <tbody>
          {refunds.length === 0 ? <EmptyRow colSpan={HEADERS.length}><EmptyState title="No refunds." body="Refund requests appear here until they are completed." /></EmptyRow> : null}
          {refunds.map((r) => (
            <tr key={r.id} {...itemProps(r.id, selectedId, setSelectedId)}>
              <td suppressHydrationWarning>{hhmm(age(r))}</td>
              <td><DateText value={r.requested_at as Iso} withTime /></td>
              <td>{gatewayLabel(r.gateway)}</td>
              <td className="lims-align-end lims-num">{amt(r.amount)}</td>
              <td>{statusChip(r)}</td>
            </tr>
          ))}
        </tbody>
        {refunds.length === 0 ? <PlaceholderRows colSpan={HEADERS.length} /> : null}
      </table>
    </div></div>
  );

  const detail = sel ? (
    <>
      <h2>{`Refund of ${nprText(sel.amount)}`}</h2>
      <Facts items={[
        ['Gateway', gatewayLabel(sel.gateway)],
        ['Amount', amt(sel.amount)],
        ['Status', statusChip(sel)],
        ['Mode', sel.mode === 'api' ? 'Provider API' : 'Manual'],
        ['Requested by', sel.requested_by?.display_name || '—'],
        ['Approved by', sel.approved_by?.display_name || '—'],
        ['Reason under review', sel.held_reason ? holdName.get(sel.held_reason) ?? humanize(sel.held_reason) : '—'],
        ['Payment', <a key="p" href={`/payments/intents/${sel.intent_id}`} aria-label={`Payment ${sel.intent_id.slice(0, 8)}`}><IdText value={sel.intent_id} /></a>],
      ]} />
      <History events={[['Requested', sel.requested_at] as const, ...(sel.approved_at ? [['Approved', sel.approved_at] as const] : [])]} />
    </>
  ) : <p>Select a refund to see it here.</p>;

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
      <PageHeader title={t('payments.nav.refunds')} helpKey="payments.refunds" />
      {banner ? <div role="alert"><Banner tone="danger" title={banner} /></div> : null}
      <FilterBar filters={filters} value={value} onChange={go} onReset={() => router.push(BASE)} />
      <StatTileRow>
        <StatTile label="Pending approval" value={String(pending.length)} />
        <StatTile label="With provider" value={String(refunds.filter((r) => WITH_PROVIDER.includes(r.status)).length)} />
        <StatTile label="Oldest age" value={oldest(pending.map(age))} />
      </StatTileRow>
      <ShortcutKey letter={first?.key} run={first && !first.blocked ? first.run : undefined}>
        <SplitConsole list={list} detail={detail} listLabel="Refund queue" detailLabel="Refund" actions={sel ? actions(sel) : undefined} />
      </ShortcutKey>
      {nextCursor || hasPrevious ? (
        <div className="lims-pager">
          <Button size="sm" variant="secondary" isDisabled={!hasPrevious} onPress={() => router.back()}>Previous</Button>
          <Button size="sm" variant="secondary" isDisabled={!nextCursor} onPress={() => nextCursor && go(value, nextCursor)}>Next</Button>
        </div>
      ) : null}
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
function SecondPersonHint({ label }: { label: string }) {
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <span
      tabIndex={0} {...(show ? { 'aria-describedby': id } : {})} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onFocus={() => setShow(true)}
      onBlur={() => setShow(false)} onKeyDown={(e) => { if (e.key === 'Escape') setShow(false); }}
    >
      <Button size="sm" variant="secondary" isDisabled>{label}</Button>
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
