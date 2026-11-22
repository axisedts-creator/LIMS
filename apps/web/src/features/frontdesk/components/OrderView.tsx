'use client';
// 04-UI-UX §4 Order page (route staff.frontdesk.order): header + tabs Items / Billing / Attachments; Cancel order; pre-registered banner.
// Actions are permission-gated UI hints (the API enforces). Writes go through server actions with Idempotency-Key (one per dialog open, so a
// retry is the same request) and If-Match = the order version. Failures close the dialog and show one readable banner (never raw codes).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { MoneyField, type Money as FieldMoney } from '@lims/ui/components/MoneyField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { PAYMENT_METHODS } from '@/features/billing/server/types';
// T0D-OFFLINE-3 (LD-322; done_when 4): cancel is online only; offline the button is disabled with the reason next to it
import { useOnlineOnly } from '@/core/offline/ui/OfflineProvider';
import { cancelOrderAction, changeOrderItemsAction, quoteItemsChangeAction, recordPaymentAction, uploadTrfAction } from '../server/actions';
import type { CatalogOption, Coded, Order, OrderBilling, OrderItem } from '../server/types';
import { BsAd, Status, errorText, formatNpr, hasPerm, humanize, npr } from './format';
import './frontdesk.css';

type Tab = 'items' | 'billing' | 'attachments';
type Open = { kind: 'none' } | { kind: 'cancel' } | { kind: 'add' } | { kind: 'pay' } | { kind: 'remove'; item: OrderItem };
const newKey = () => crypto.randomUUID();
const GONE = ['removed', 'cancelled'];
const PRIORITIES = [{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }] as const;
const SCAN_TEXT: Record<string, string> = { clean: 'Clean', pending: 'Scan pending', quarantined: 'File rejected by security scan' };
const BASIS_TEXT = (eligible: boolean, basis: string) => `Report release: ${eligible ? 'eligible' : 'not eligible'} — ${humanize(basis)}`;

export function OrderView({ order, billing, permissions, cancelReasons, removalReasons, catalogOptions }: { order: Order; billing: OrderBilling | null; permissions: readonly string[]; cancelReasons: readonly Coded[]; removalReasons: readonly Coded[]; catalogOptions: readonly CatalogOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('items');
  const [open, setOpen] = useState<Open>({ kind: 'none' });
  const [notice, setNotice] = useState<string>();
  const key = useRef(newKey());
  const fileInput = useRef<HTMLInputElement>(null);
  const openDialog = (o: Open) => { key.current = newKey(); setNotice(undefined); setOpen(o); };
  const close = () => setOpen({ kind: 'none' });
  const fail = (code: string, status?: number) => { close(); setNotice(errorText(code, status)); };
  const done = (title: string) => { close(); toast.show({ tone: 'success', title }); router.refresh(); };

  const cancelled = order.status === 'cancelled';
  const editable = order.status === 'registered' && hasPerm(permissions, 'frontdesk.order.edit');
  const canCancel = !cancelled && hasPerm(permissions, 'frontdesk.order.cancel');
  const cancelGate = useOnlineOnly('order.cancel');
  // Booked orders are confirmed through the registration payment panel (F12 needs quote_fingerprint + payments, FD-T13); this page only flags them.
  const booked = order.status === 'pre_registered' && hasPerm(permissions, 'frontdesk.registration.create');
  const paid = billing?.balance.paid.amount_paisa ?? 0;
  const tabs = [{ id: 'items', label: 'Items' }, ...(billing ? [{ id: 'billing', label: 'Billing' }] : []), { id: 'attachments', label: 'Attachments' }];

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    const r = await uploadTrfAction(order.centre_id, order.id, form, key.current);
    if (r.ok) done('File uploaded. It is being scanned.'); else fail(r.code, r.status);
  };

  return (
    <section aria-label={`Order ${order.registration_no}`}>
      <PageHeader
        title={order.registration_no}
        helpKey="frontdesk.order"
        status={<Status status={order.status} />}
        actions={canCancel ? <><Button variant="danger" isDisabled={cancelGate.disabled} onPress={() => openDialog({ kind: 'cancel' })}>Cancel order</Button>{cancelGate.reason ? <span className="lims-description">{cancelGate.reason}</span> : null}</> : null}
      />
      {/* T0D-UIX-4 (LD-442): the order header fields are the kit DescriptionList. */}
      <DescriptionList columns={3} items={[
        { term: 'Patient', value: <><a className="lims-link" href={`/frontdesk/patients/${order.patient.id}`}>{order.patient.full_name}</a> ({order.patient.patient_code}, {humanize(order.patient.sex)}{order.patient.age_at_order ? `, ${order.patient.age_at_order}` : ''})</> },
        { term: 'Visit type', value: order.visit_type.toUpperCase() },
        { term: 'Billing mode', value: humanize(order.billing_mode) },
        ...(order.referrer_name ? [{ term: 'Referrer', value: order.referrer_name }] : []),
        ...(order.registered_at ? [{ term: 'Registered', value: <BsAd utc={order.registered_at} /> }] : []),
        ...(order.flags.length ? [{ term: 'Flags', value: order.flags.map((f) => <span key={f.id} className="lims-chip lims-chip-gap">{humanize(f.kind)} ({f.status})</span>) }] : []),
      ]} />

      {notice ? <div role="alert"><Banner tone="danger" title={notice} /></div> : null}
      {booked ? <Banner tone="info" title="Booked — confirm on arrival" /> : null}
      {cancelled && order.requires_credit_note ? <Banner tone="warning" title="Credit note required — Finance must issue a credit note for this cancelled order." /> : null}

      <Tabs items={tabs} selectedId={tab} onChange={(id) => setTab(id as Tab)} aria-label="Order sections">
        {tab === 'items' ? (
          <>
            {editable ? <Button variant="primary" onPress={() => openDialog({ kind: 'add' })}>Add tests</Button> : null}
            <DataTable
              caption="Order items"
              rows={order.items}
              getRowId={(i) => i.id}
              emptyState={{ title: 'No tests on this order.' }}
              columns={[
                { id: 'code', header: 'Code', cell: (i) => i.code },
                { id: 'name', header: 'Name', isRowHeader: true, cell: (i) => i.name },
                { id: 'priority', header: 'Priority', cell: (i) => humanize(i.priority) },
                { id: 'status', header: 'Status', cell: (i) => humanize(i.status) },
                { id: 'price', header: 'Price', numeric: true, cell: (i) => npr(i.unit_price) },
                { id: 'actions', header: 'Actions', cell: (i) => (editable && !GONE.includes(i.status) ? <Button size="sm" onPress={() => openDialog({ kind: 'remove', item: i })}>Remove</Button> : null) },
              ] satisfies ColumnDef<OrderItem>[]}
            />
          </>
        ) : null}
        {tab === 'billing' && billing ? <BillingTab billing={billing} permissions={permissions} onPay={() => openDialog({ kind: 'pay' })} /> : null}
        {tab === 'attachments' ? (
          <>
            {hasPerm(permissions, 'frontdesk.trf.upload') ? (
              <>
                <Button onPress={() => fileInput.current?.click()}>Upload</Button>
                <input ref={fileInput} type="file" hidden aria-label="TRF file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => { key.current = newKey(); void upload(e.target.files?.[0]); e.target.value = ''; }} />
              </>
            ) : null}
            {/* T0D-UIGUARD-1-FRONTDESK (LD-353 rule 5): the table keeps its header when there are no attachments. */}
            <DataTable
              caption="Test request forms"
              rows={order.trf_attachments}
              getRowId={(a) => a.id}
              emptyState={{ title: 'No attachments.' }}
              columns={[
                { id: 'file', header: 'File', isRowHeader: true, cell: (a) => a.original_filename ?? humanize(a.mime_type) },
                { id: 'scan', header: 'Scan', cell: (a) => SCAN_TEXT[a.scan_state] ?? humanize(a.scan_state) },
                { id: 'by', header: 'Uploaded by', cell: (a) => a.uploaded_by?.display_name ?? '—' },
                { id: 'at', header: 'Uploaded', cell: (a) => <BsAd utc={a.created_at} /> },
                // Preview goes through the BFF content route only; a Storage URL never reaches the browser (07-SECURITY).
                { id: 'actions', header: 'Actions', cell: (a) => (a.scan_state === 'clean' ? <a className="lims-link" href={`/frontdesk/trf-attachments/${a.id}/content`}>Preview</a> : null) },
              ] satisfies ColumnDef<Order['trf_attachments'][number]>[]}
            />
          </>
        ) : null}
      </Tabs>

      <ConfirmDialog
        key={`cancel-${key.current}`}
        title="Cancel order"
        tone="danger"
        isOpen={open.kind === 'cancel'}
        confirmLabel="Cancel order"
        onCancel={close}
        requireReason={{ codedSet: 'frontdesk.order_cancel_reasons', options: cancelReasons, freeText: { maxLength: 500, isRequired: false } }}
        body={<><p>This order will be cancelled and cannot be reopened.</p>{paid > 0 ? <p>Finance must issue a credit note and refund {formatNpr(paid)}.</p> : null}</>}
        onConfirm={async ({ reasonCode, reasonText }) => {
          if (!reasonCode) return;
          const r = await cancelOrderAction(order.id, order.version, { reason_code: reasonCode, ...(reasonText ? { reason_text: reasonText } : {}) }, key.current);
          if (r.ok) done('Order cancelled.'); else fail(r.code, r.status);
        }}
      />
      <ConfirmDialog
        key={`remove-${key.current}`}
        title="Remove test"
        tone="danger"
        isOpen={open.kind === 'remove'}
        confirmLabel="Remove"
        onCancel={close}
        requireReason={{ codedSet: 'frontdesk.item_removal_reasons', options: removalReasons }}
        body={<p>The test is removed from this order. If it was already invoiced, Finance issues a credit note.</p>}
        onConfirm={async ({ reasonCode }) => {
          if (!reasonCode || open.kind !== 'remove') return;
          const r = await changeOrderItemsAction(order.id, order.version, { remove: [{ order_item_id: open.item.id, reason_code: reasonCode }] }, key.current);
          if (r.ok) done('Test removed.'); else fail(r.code, r.status);
        }}
      />
      {open.kind === 'add' ? <AddTestsDialog order={order} options={catalogOptions} idempotencyKey={key.current} onClose={close} onDone={() => done('Tests added.')} onFail={fail} /> : null}
      {open.kind === 'pay' && billing ? <PaymentDialog order={order} due={billing.balance.balance_due.amount_paisa} idempotencyKey={key.current} onClose={close} onDone={() => done('Payment recorded.')} onFail={fail} /> : null}
    </section>
  );
}

function BillingTab({ billing, permissions, onPay }: { billing: OrderBilling; permissions: readonly string[]; onPay: () => void }) {
  const b = billing.balance;
  return (
    <>
      <p>Invoiced {npr(b.invoiced)} · Paid {npr(b.paid)} · Credited {npr(b.credited)} · Balance due <strong>{npr(b.balance_due)}</strong></p>
      <p>{BASIS_TEXT(billing.eligibility.release_eligible, billing.eligibility.release_basis)}</p>
      {hasPerm(permissions, 'billing.payment.record') ? <Button variant="primary" onPress={onPay}>Record payment</Button> : null}
      {/* Printing and copies live on the invoice page (billing.invoice.reprint is enforced there). */}
      <DataTable
        caption="Invoices"
        rows={billing.invoices}
        getRowId={(i) => i.id}
        emptyState={{ title: 'No invoices yet.' }}
        columns={[
          { id: 'no', header: 'Invoice no', isRowHeader: true, cell: (i) => <a className="lims-link" href={`/billing/invoices/${i.id}`}>{i.invoice_no}</a> },
          { id: 'date', header: 'Date', cell: (i) => <BsAd bs={i.invoice_date_bs} utc={i.issued_at} /> },
          { id: 'net', header: 'Net', numeric: true, cell: (i) => npr(i.net) },
          { id: 'status', header: 'Status', cell: (i) => humanize(i.status) },
          { id: 'prints', header: 'Prints', numeric: true, cell: (i) => i.print_count ?? 0 },
        ] satisfies ColumnDef<OrderBilling['invoices'][number]>[]}
      />
      <DataTable
        caption="Payments and ledger"
        rows={billing.ledger_entries}
        getRowId={(l) => l.id}
        emptyState={{ title: 'No payments yet.' }}
        columns={[
          { id: 'receipt', header: 'Receipt no', isRowHeader: true, cell: (l) => l.receipt_no ?? '—' },
          { id: 'kind', header: 'Kind', cell: (l) => humanize(l.entry_kind) },
          { id: 'method', header: 'Method', cell: (l) => (l.method_code ? humanize(l.method_code) : '—') },
          { id: 'amount', header: 'Amount', numeric: true, cell: (l) => npr(l.amount) },
          { id: 'by', header: 'By', cell: (l) => l.collected_by?.display_name ?? '—' },
          { id: 'time', header: 'Time', cell: (l) => <BsAd utc={l.created_at} withTime /> },
        ] satisfies ColumnDef<OrderBilling['ledger_entries'][number]>[]}
      />
      {/* T0D-UIGUARD-1-FRONTDESK (LD-436 R7, LD-439): finance sections are kit Cards with a title row; the items keep list semantics. */}
      {billing.open_credit_note_tasks.length ? <Card title="Open tasks" region><div role="list">{billing.open_credit_note_tasks.map((t) => <div role="listitem" key={t.id}>Credit note needed — {humanize(t.cause)}</div>)}</div></Card> : null}
      {billing.refund_requests.length ? <Card title="Refunds" region><div role="list">{billing.refund_requests.map((r) => <div role="listitem" key={r.id}><span>{npr(r.refund_amount)}</span> by {humanize(r.method_code)} — <span>{humanize(r.status)}</span></div>)}</div></Card> : null}
      {billing.open_finance_review_items.length ? <Card title="Review" region><div role="list">{billing.open_finance_review_items.map((r) => <div role="listitem" key={r.id}>{humanize(r.kind ?? 'review')} item to review</div>)}</div></Card> : null}
    </>
  );
}

function AddTestsDialog({ order, options, idempotencyKey, onClose, onDone, onFail }: { order: Order; options: readonly CatalogOption[]; idempotencyKey: string; onClose: () => void; onDone: () => void; onFail: (code: string, status?: number) => void }) {
  const [orderableId, setOrderableId] = useState<string>();
  const [priority, setPriority] = useState<'routine' | 'urgent'>('routine');
  const [quote, setQuote] = useState<{ net: number; fp: string }>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const add = () => [{ orderable_id: orderableId!, priority }];
  const guarded = async (f: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { await f(); } finally { inFlight.current = false; }
  };
  const getQuote = () => guarded(async () => {
    if (!orderableId) return setError('Choose a test.');
    const r = await quoteItemsChangeAction(order.id, add());
    if (r.ok) { setError(undefined); setQuote({ net: r.data.net_paisa, fp: r.data.quote_fingerprint }); } else onFail(r.code, r.status);
  });
  const confirm = () => guarded(async () => {
    if (!quote) return;
    const r = await changeOrderItemsAction(order.id, order.version, { add: add(), quote_fingerprint: quote.fp }, idempotencyKey);
    if (r.ok) onDone(); else onFail(r.code, r.status);
  });
  return (
    <Dialog title="Add tests" isOpen onClose={onClose} size="md">
      {error ? <p role="alert">{error}</p> : null}
      <Select label="Test" name="orderable_id" isRequired options={options.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }))} {...(orderableId ? { value: orderableId } : {})} onChange={(v) => { setOrderableId(v); setQuote(undefined); setError(undefined); }} />
      <Select label="Priority" name="priority" options={PRIORITIES} value={priority} onChange={(v) => { setPriority(v as 'routine' | 'urgent'); setQuote(undefined); }} />
      {quote ? <p>Added tests total: <strong>{formatNpr(quote.net)}</strong></p> : null}
      {quote ? <Button variant="primary" onPress={() => void confirm()}>Add</Button> : <Button variant="primary" onPress={() => void getQuote()}>Get quote</Button>}
    </Dialog>
  );
}

function PaymentDialog({ order, due, idempotencyKey, onClose, onDone, onFail }: { order: Order; due: number; idempotencyKey: string; onClose: () => void; onDone: () => void; onFail: (code: string, status?: number) => void }) {
  const [method, setMethod] = useState<string>();
  const [amount, setAmount] = useState<FieldMoney | undefined>();
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    if (!method || !amount || amount.amountPaisa < 1) return setError('Choose a method and an amount.');
    inFlight.current = true;
    try {
      const r = await recordPaymentAction(order.id, { method_code: method, amount_received_paisa: amount.amountPaisa, ...(reference.trim() ? { reference: reference.trim() } : {}) }, idempotencyKey);
      if (r.ok) onDone(); else onFail(r.code, r.status);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog title="Record payment" isOpen onClose={onClose} size="md">
      <Form onSubmit={submit}>
        {error ? <p role="alert">{error}</p> : null}
        <p>Balance due: {formatNpr(due)}</p>
        <Select label="Payment method" name="method_code" isRequired options={PAYMENT_METHODS.map((m) => ({ value: m.code, label: m.display }))} {...(method ? { value: method } : {})} onChange={setMethod} />
        <MoneyField label="Amount received" name="amount" isRequired max={{ amountPaisa: due, currency: 'NPR' }} {...(amount ? { value: amount } : {})} onChange={setAmount} />
        <TextField label="Reference" name="reference" maxLength={64} value={reference} onChange={setReference} />
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Record payment</Button>
      </Form>
    </Dialog>
  );
}
