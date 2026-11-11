'use client';
// 04-UI-UX §2.2 Intent detail. Facts for everyone with payments.reconciliation.read; the resolve actions only with payments.intent.resolve.
// Buttons call server actions (token stays on the server). A payment is shown as paid only when the server says `settled`.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { IdText } from '@lims/ui/components/IdText';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import { cancelAction, recheckAction, resolveAction, type ActionResult } from '../server/actions';
import { gatewayLabel, hasPerm, humanize, lower, nprText, statusLabel, statusTone } from '../labels';
import { RefundRequestDialog } from './RefundRequestDialog';
import type { CodedValue, IntentCodes, PaymentCallback, PaymentGatewayCheck, PaymentIntentDetail, PaymentMoney, PaymentRefund } from '../types';

type Iso = DateTextProps['value'];
type Fail = Extract<ActionResult, { ok: false }>;
type Reason = { reasonCode?: string; reasonText?: string };
interface Dlg {
  id: 'paid' | 'exceeding' | 'failed' | 'cancel';
  title: string; body: string; confirmLabel: string; tone?: 'danger'; codedSet: string; reasons: readonly CodedValue[]; freeText: boolean;
  call: (code: string, text: string | undefined, key: string) => Promise<ActionResult>;
}
interface BannerState { tone: 'warning' | 'danger'; title: string; reload?: boolean }

const RECHECKABLE = ['initiated', 'pending', 'held_for_review'];
const CANCELLABLE = ['initiated', 'pending'];
const REFUNDABLE = ['settled', 'partially_refunded'];
const OTHER_FAILURE = 'Something went wrong. Try again; if it keeps failing, contact support.';
const RATE_LIMITED = 'Checked a moment ago. Try again in a few seconds.';

function problemBanner(r: Fail, answer: string): BannerState {
  switch (r.code) {
    case 'payments.intent_not_verifiable': return { tone: 'warning', title: `The provider has not confirmed this payment (latest answer: ${r.latest ?? answer}). It cannot be marked paid.` };
    case 'common.version_conflict': return { tone: 'warning', title: 'This payment changed. Reload to see the latest.', reload: true };
    case 'payments.intent_invalid_transition': return { tone: 'warning', title: 'This payment cannot be changed that way any more. Reload to see the latest.', reload: true };
    case 'payments.gateway_not_available': return { tone: 'warning', title: 'The provider is not available right now. Try again in a little while.' };
    case 'auth.mfa_required': return { tone: 'warning', title: 'Extra verification is needed for this action. Verify with your authenticator app, then try again.' };
    case 'auth.forbidden': return { tone: 'danger', title: 'You do not have permission to do this.' };
    default: return { tone: 'danger', title: OTHER_FAILURE };
  }
}

const actor = (t: string) => (t === 'user' ? 'Staff' : 'System');
const yesNo = (v: boolean | undefined) => (v === undefined ? '—' : v ? 'Yes' : 'No');
const when = (v: string) => <DateText value={v as Iso} withTime />;
const withIds = <T,>(rows: readonly T[] | undefined) => (rows ?? []).map((r, i) => ({ ...r, _id: String(i) }));

export function IntentDetailView({ intent, permissions, codes, overpaid }: { intent: PaymentIntentDetail; permissions: readonly string[]; codes: IntentCodes; overpaid?: PaymentMoney | undefined }) {
  const router = useRouter();
  const toast = useToast();
  const canResolve = hasPerm(permissions, 'payments.intent.resolve');
  const canRefund = hasPerm(permissions, 'payments.refund.request') && REFUNDABLE.includes(intent.status);
  const held = intent.status === 'held_for_review';
  const canRecheck = canResolve && RECHECKABLE.includes(intent.status);
  const [dialog, setDialog] = useState<Dlg | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [needText, setNeedText] = useState(false);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [tab, setTab] = useState('timeline');
  const [checking, setChecking] = useState(false);
  const key = useRef('');
  const inFlight = useRef(false);
  const answer = intent.last_gateway_status_raw ?? 'none';

  const recheck = async () => {
    if (inFlight.current || !canRecheck) return;
    inFlight.current = true;
    setChecking(true);
    setBanner(null);
    try {
      const r = await recheckAction(intent.id);
      if (r.ok) {
        toast.show({ tone: 'info', title: `Checked: ${statusLabel(r.status ?? intent.status)}` });
        router.refresh();
      } else if (r.status === 429) toast.show({ tone: 'info', title: RATE_LIMITED });
      else setBanner(problemBanner(r, answer));
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  };
  const recheckRef = useRef(recheck);
  recheckRef.current = recheck;
  useEffect(() => {
    if (!canRecheck) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || (e.code !== 'KeyC' && e.key.toLowerCase() !== 'c') || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      void recheckRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canRecheck]);

  const open = (d: Dlg) => {
    key.current = globalThis.crypto.randomUUID(); // one idempotency key per opened dialog: a retry of the same confirmation replays, never doubles
    setNeedText(false);
    setBanner(null);
    setDialog(d);
  };
  const resolveDlg = (id: Dlg['id'], title: string, body: string, confirmLabel: string, resolution: 'settle' | 'fail' | 'record_exceeding_due', tone?: 'danger'): Dlg => ({
    id, title, body, confirmLabel, ...(tone ? { tone } : {}), codedSet: 'payments.resolution_reasons', reasons: codes.resolution_reasons, freeText: true,
    call: (code, text, k) => resolveAction(intent.id, intent.version, resolution, code, text, k),
  });
  const verified = nprText(intent.verified_amount ?? intent.amount);
  const dlgPaid = () => resolveDlg('paid', 'Mark payment as paid?', 'The provider will be checked again. The payment is marked paid only if the provider confirms it with the exact amount.', 'Mark as paid', 'settle');
  const dlgExceeding = () => resolveDlg('exceeding', 'Record although it exceeds the due?', `The provider confirmed ${verified}. The order now owes less. The full amount will be recorded and Finance will get a review item to refund or keep as advance.`, 'Record payment', 'record_exceeding_due');
  const dlgFailed = () => resolveDlg('failed', 'Mark payment as failed?', 'Only do this if the provider confirmed that no money was taken.', 'Mark as failed', 'fail', 'danger');
  const dlgCancel = (): Dlg => ({
    id: 'cancel', title: 'Cancel this payment?', body: 'We check with the provider first. If the patient already paid, the payment is recorded instead.', confirmLabel: 'Cancel payment',
    codedSet: 'payments.cancel_reasons', reasons: codes.cancel_reasons, freeText: false, call: (code, _text, k) => cancelAction(intent.id, code, k),
  });

  const submit = async (d: Dlg, r: Reason) => {
    const picked = d.reasons.find((x) => x.code === r.reasonCode);
    if (!r.reasonCode || (picked?.requires_text && d.freeText && !r.reasonText?.trim())) { setNeedText(true); return; }
    setNeedText(false);
    const res = await d.call(r.reasonCode, r.reasonText, key.current);
    setDialog(null);
    if (res.ok) {
      toast.show({ tone: 'info', title: 'Payment updated.' });
      router.refresh();
    } else setBanner(problemBanner(res, answer));
  };

  const terms = [
    { term: 'Order', value: <a href={`/frontdesk/orders/${intent.order_id}`}><IdText value={intent.order_id} truncate={64} /></a> },
    { term: 'Centre', value: <IdText value={intent.centre_id} truncate={64} /> },
    { term: 'Amount', value: nprText(intent.amount) },
    { term: 'Provider reference', value: intent.gateway_txn_ref ? <IdText value={intent.gateway_txn_ref} truncate={64} copyable /> : '—' },
    { term: 'Provider transaction', value: intent.gateway_secondary_ref ? <IdText value={intent.gateway_secondary_ref} truncate={64} /> : '—' },
    { term: 'Created', value: when(intent.created_at) },
    { term: 'Expires', value: intent.expires_at ? when(intent.expires_at) : '—' },
    { term: 'Paid at', value: intent.settled_at ? when(intent.settled_at) : '—' },
    { term: 'Verified amount', value: nprText(intent.verified_amount) },
    { term: 'Verification', value: intent.verification_method ? `${gatewayLabel(intent.gateway)} ${lower(intent.verification_method)}` : '—' },
    { term: 'Hold reason', value: intent.hold_reason ? humanize(intent.hold_reason) : '—' },
    { term: 'Ledger entry', value: intent.ledger_entry_id ? <a href={`/frontdesk/orders/${intent.order_id}`}><IdText value={intent.ledger_entry_id} /></a> : '—' },
    { term: 'Refunded', value: nprText(intent.refunded_amount) },
  ];

  const checkCols: ColumnDef<PaymentGatewayCheck & { _id: string }>[] = [
    { id: 'when', header: 'When', isRowHeader: true, cell: (r) => when(r.at) },
    { id: 'operation', header: 'Operation', cell: (r) => humanize(r.operation) },
    { id: 'outcome', header: 'Outcome', cell: (r) => humanize(r.outcome) },
    { id: 'status', header: 'Provider status', cell: (r) => r.gateway_status_raw ?? '—' },
    { id: 'http', header: 'HTTP status', align: 'end', cell: (r) => (r.http_status === undefined ? '—' : String(r.http_status)) },
  ];
  const callbackCols: ColumnDef<PaymentCallback & { _id: string }>[] = [
    { id: 'when', header: 'When', isRowHeader: true, cell: (r) => when(r.at) },
    { id: 'kind', header: 'Kind', cell: (r) => humanize(r.kind) },
    { id: 'outcome', header: 'Outcome', cell: (r) => humanize(r.outcome_code) },
    { id: 'signature', header: 'Signature valid', cell: (r) => yesNo(r.signature_valid) },
  ];
  const refundCols: ColumnDef<PaymentRefund & { _id: string }>[] = [
    { id: 'requested', header: 'Requested', isRowHeader: true, cell: (r) => when(r.requested_at) },
    { id: 'amount', header: 'Amount', align: 'end', cell: (r) => <MoneyText value={{ amountPaisa: r.amount.amount_paisa, currency: 'NPR' }} /> },
    { id: 'status', header: 'Status', cell: (r) => <StatusChip kind="generic" status={r.status} label={humanize(r.status)} /> },
    { id: 'reason', header: 'Reason', cell: (r) => humanize(r.reason_code) },
  ];
  const table = <Row extends { _id: string }>(caption: string, cols: ColumnDef<Row>[], rows: Row[], empty: string) => (
    <DataTable<Row> columns={cols} rows={rows} getRowId={(r) => r._id} density="compact" caption={caption} emptyState={{ title: empty, body: 'Nothing has been recorded yet.' }} />
  );

  const panel =
    tab === 'checks' ? table('Provider checks', checkCols, withIds(intent.gateway_checks), 'No provider checks yet')
    : tab === 'callbacks' ? table('Callbacks', callbackCols, withIds(intent.callbacks), 'No callbacks yet')
    : tab === 'refunds' ? table('Refunds', refundCols, withIds(intent.refunds), 'No refunds')
    : (intent.transitions?.length ?? 0) === 0 ? <p>No events yet.</p>
    : (
      <Timeline
        items={intent.transitions!.map((t) => ({
          at: t.at, label: `${statusLabel(t.to_status)}${t.reason_code ? ` — ${lower(t.reason_code)}` : ''}`, actor: actor(t.actor_type), tone: statusTone(t.to_status),
        }))}
      />
    );

  const actions = (
    <>
      {canResolve ? (
        <>
          <Button variant="secondary" shortcut="Alt+C" isDisabled={!canRecheck} isLoading={checking} onPress={() => void recheck()}>Re-check with provider</Button>
          <Button variant="primary" isDisabled={!held} onPress={() => open(dlgPaid())}>Mark as paid</Button>
          {held && intent.hold_reason === 'exceeds_due' ? <Button variant="secondary" onPress={() => open(dlgExceeding())}>Record although it exceeds the due</Button> : null}
          <Button variant="danger" isDisabled={!held} onPress={() => open(dlgFailed())}>Mark as failed</Button>
          <Button variant="ghost" isDisabled={!CANCELLABLE.includes(intent.status)} onPress={() => open(dlgCancel())}>Cancel payment</Button>
        </>
      ) : null}
      {canRefund ? <Button variant="secondary" onPress={() => setRefundOpen(true)}>Request refund</Button> : null}
    </>
  );

  return (
    <>
      <PageHeader title="Payment" helpKey="payments.intent" status={<StatusChip kind="payment_intent" status={intent.status} />} actions={actions} />
      <p>{nprText(intent.amount)} · {gatewayLabel(intent.gateway)}</p>
      {banner ? (
        <div role="alert">
          <Banner tone={banner.tone} title={banner.title} {...(banner.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} />
        </div>
      ) : null}
      <DescriptionList columns={2} items={terms} />
      <Tabs
        aria-label="Payment history" selectedId={tab} onChange={setTab}
        items={[{ id: 'timeline', label: 'Timeline' }, { id: 'checks', label: 'Provider checks' }, { id: 'callbacks', label: 'Callbacks' }, { id: 'refunds', label: 'Refunds' }]}
      >
        {panel}
      </Tabs>
      {dialog ? (
        <ConfirmDialog
          key={`${dialog.id}-${key.current}`}
          isOpen title={dialog.title} confirmLabel={dialog.confirmLabel} {...(dialog.tone ? { tone: dialog.tone } : {})}
          body={<><p>{dialog.body}</p>{needText ? <p role="alert" className="lims-error">Enter details for this reason.</p> : null}</>}
          requireReason={{ codedSet: dialog.codedSet, options: dialog.reasons, ...(dialog.freeText ? { freeText: { maxLength: 500, isRequired: false } } : {}) }}
          onCancel={() => { setNeedText(false); setDialog(null); }}
          onConfirm={(r) => submit(dialog, r)}
        />
      ) : null}
      {canRefund ? <RefundRequestDialog intent={intent} overpaid={overpaid} refundReasons={codes.refund_reasons ?? []} isOpen={refundOpen} onClose={() => setRefundOpen(false)} /> : null}
    </>
  );
}
