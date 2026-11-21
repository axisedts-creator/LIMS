'use client';
// 04-UI-UX §8.2 Invoice detail: fiscal layout (same as print) + side panel (print history, credit notes, CBMS submissions).
// Actions are permission-gated UI hints (the API enforces): Print B3, Cancel B4, Partial credit B5, Request refund B10.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { MoneyField, type Money as FieldMoney } from '@lims/ui/components/MoneyField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { cancelInvoiceAction, issuePartialCreditNoteAction, printInvoiceAction, requestRefundAction } from '../server/actions';
import { CANCEL_REASONS, PAYMENT_METHODS, PRINT_STYLES, REFUND_REASONS, REPRINT_REASONS, STYLE_LABEL, type CreditNoteSummary, type InvoiceDetail, type InvoicePrintDocument, type InvoicePrintRow, type PrintStyle } from '../server/types';
import { Ad, BsAd, InvoiceStatus, cbmsLabel, errorText, formatNpr, hasPerm, humanize, npr } from './format';
import { InvoiceDocument } from './InvoiceDocument';
import { InvoicePrintFrame } from './print/InvoicePrintView';
import './billing.css';
// T0D-OFFLINE-3 (LD-322; done_when 4): refund and cancel are online only; offline they are disabled with the reason shown
import { useOnlineOnly } from '@/core/offline/ui/OfflineProvider';
import { readPrintStyle, writePrintStyle } from '@/core/prefs/print-style';

type Open = 'none' | 'cancel' | 'print' | 'credit' | 'refund';
const newKey = () => crypto.randomUUID();
// T0D-PRINTCFG-1 done_when (4) (LD-316): the last print style is remembered per browser through core/prefs (untrusted values read Full bill).
const isStyle = (v: unknown): v is PrintStyle => PRINT_STYLES.includes(v as PrintStyle);
const rememberedStyle = readPrintStyle;
const remember = writePrintStyle;
/** Style of the first print (lowest print_no); rows printed before styles existed read full. undefined when no row is known. */
const firstStyle = (prints: readonly InvoicePrintRow[]): PrintStyle | undefined => {
  const first = [...prints].sort((a, b) => a.print_no - b.print_no)[0];
  return first ? (isStyle(first.style) ? first.style : 'full') : undefined;
};

export function InvoiceDetailView({ invoice, prints, creditNotes, permissions }: { invoice: InvoiceDetail; prints: readonly InvoicePrintRow[]; creditNotes: readonly CreditNoteSummary[]; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Open>('none');
  const [printing, setPrinting] = useState<{ document: InvoicePrintDocument; style: PrintStyle } | null>(null);
  // One Idempotency-Key per dialog open: a retry after a failure is the same request (02-CONVENTIONS §4.5).
  const key = useRef(newKey());
  const openDialog = (o: Open) => { key.current = newKey(); setOpen(o); };
  const cancelled = invoice.status === 'cancelled';
  const remaining = Math.max(0, invoice.totals.net.amount_paisa - invoice.credited_total.amount_paisa);
  const canPrint = hasPerm(permissions, 'billing.invoice.reprint');
  const canCancel = hasPerm(permissions, 'billing.invoice.cancel') && !cancelled;
  const canRefund = (hasPerm(permissions, 'billing.refund.request') || hasPerm(permissions, 'billing.refund.approve')) && !!invoice.order_id;
  const refundGate = useOnlineOnly('order.refund');
  const cancelGate = useOnlineOnly('order.cancel');
  const fail = (code: string, title: string) => toast.show({ tone: 'danger', title, description: errorText(code) });

  const doPrint = async (reasonCode: string, style: PrintStyle) => {
    const r = await printInvoiceAction(invoice.id, reasonCode, key.current, style);
    if (!r.ok) return fail(r.code, 'Could not print the invoice');
    setOpen('none');
    setPrinting({ document: { ...r.data.document, ...(r.data.copy_mark ? { copy_mark: r.data.copy_mark } : {}) }, style: isStyle(r.data.style) ? r.data.style : style });
  };

  return (
    <section aria-label={`Invoice ${invoice.invoice_no}`}>
      <PageHeader
        title={`Invoice ${invoice.invoice_no}`}
        helpKey="billing.invoice"
        status={<InvoiceStatus status={invoice.status} />}
        actions={
          <>
            {canPrint ? (
              <Button variant="primary" onPress={() => openDialog('print')}>Print</Button>
            ) : null}
            {canCancel ? <Button variant="danger" isDisabled={cancelGate.disabled} onPress={() => openDialog('cancel')}>Cancel invoice</Button> : null}
            {canCancel ? <Button isDisabled={cancelGate.disabled} onPress={() => openDialog('credit')}>Partial credit</Button> : null}
            {canRefund ? <Button isDisabled={refundGate.disabled} onPress={() => openDialog('refund')}>Request refund</Button> : null}
            {(canCancel && cancelGate.reason) || (canRefund && refundGate.reason) ? <span className="lims-description">{canRefund ? refundGate.reason : cancelGate.reason}</span> : null}
          </>
        }
      />
      {cancelled && invoice.cancellation ? (
        <p role="status" className="lims-cancelled-banner">
          CANCELLED on <BsAd utc={invoice.cancellation.cancelled_at} /> — {invoice.cancellation.reason_text ?? humanize(invoice.cancellation.reason_code)} — Credit note {invoice.cancellation.credit_note_no}
        </p>
      ) : null}
      <div className="lims-invoice-detail">
        <div className="lims-invoice-detail-doc">
          <InvoiceDocument document={invoice} />
        </div>
        <aside aria-label="Invoice history" className="lims-invoice-detail-side">
          <h2>Print history</h2>
          {prints.length === 0 ? <p>Not printed yet.</p> : (
            <table>
              <caption>Print history</caption>
              <thead><tr><th scope="col">No</th><th scope="col">Type</th><th scope="col">Style</th><th scope="col">By</th><th scope="col">Time</th><th scope="col">Reason</th></tr></thead>
              <tbody>
                {prints.map((p) => (
                  <tr key={p.print_no}>
                    <td>{p.print_no}</td><td>{p.is_copy ? 'Copy' : 'Original'}</td><td>{STYLE_LABEL[isStyle(p.style) ? p.style : 'full']}</td><td>{p.printed_by_display}</td>
                    <td><Ad value={p.printed_at} withTime /></td><td>{humanize(p.reason_code)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>Credit notes</h2>
          {creditNotes.length === 0 ? <p>No credit notes.</p> : (
            <ul>{creditNotes.map((c) => <li key={c.id}>{c.credit_note_no} — {humanize(c.kind)} — <BsAd bs={c.credit_note_date_bs} utc={c.issued_at} /></li>)}</ul>
          )}
          <h2>CBMS</h2>
          <p>{cbmsLabel(invoice.cbms_state)}</p>
          {invoice.cbms_submissions.length === 0 ? null : (
            <table>
              <caption>CBMS submissions</caption>
              <thead><tr><th scope="col">Document</th><th scope="col">Attempt</th><th scope="col">Outcome</th><th scope="col">Time</th></tr></thead>
              <tbody>
                {invoice.cbms_submissions.map((s, n) => (
                  <tr key={n}><td>{humanize(s.document_kind)}</td><td>{s.attempt_no}</td><td>{s.outcome}</td><td><Ad value={s.submitted_at} withTime /></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </aside>
      </div>

      <ConfirmDialog
        title="Cancel invoice"
        tone="danger"
        isOpen={open === 'cancel'}
        confirmLabel="Cancel invoice"
        onCancel={() => setOpen('none')}
        requireReason={{ codedSet: 'billing.invoice_cancel_reasons', options: CANCEL_REASONS, freeText: { maxLength: 500, isRequired: false } }}
        body={<p>A credit note for {formatNpr(remaining)} will be issued. Invoices cannot be edited or deleted.</p>}
        onConfirm={async ({ reasonCode, reasonText }) => {
          if (!reasonCode) return;
          const r = await cancelInvoiceAction(invoice.id, invoice.version, { reason_code: reasonCode, ...(reasonText ? { reason_text: reasonText } : {}) }, key.current);
          if (!r.ok) return fail(r.code, 'Could not cancel the invoice');
          setOpen('none');
          toast.show({ tone: 'success', title: `Invoice cancelled. Credit note ${r.data.credit_note_no} issued.` });
          router.refresh();
        }}
      />
      {open === 'print' ? <PrintDialog reprint={invoice.print_count >= 1} first={firstStyle(prints)} onClose={() => setOpen('none')} onPrint={doPrint} /> : null}
      {printing ? <InvoicePrintFrame document={printing.document} plain={printing.style === 'plain_bw'} isOpen onDone={() => { setPrinting(null); router.refresh(); }} /> : null}
      {open === 'credit' ? <PartialCreditDialog invoice={invoice} idempotencyKey={key.current} onClose={() => setOpen('none')} onDone={(no) => { setOpen('none'); toast.show({ tone: 'success', title: `Credit note ${no} issued.` }); router.refresh(); }} onFail={(c) => fail(c, 'Could not issue the credit note')} /> : null}
      {open === 'refund' ? <RefundDialog invoice={invoice} refundable={remaining} idempotencyKey={key.current} onClose={() => setOpen('none')} onDone={() => { setOpen('none'); toast.show({ tone: 'success', title: 'Refund request sent for approval.' }); router.refresh(); }} onFail={(c) => fail(c, 'Could not request the refund')} /> : null}
    </section>
  );
}

/** T0D-PRINTCFG-1 done_when (4): Full bill or Plain black and white bill. A reprint keeps the style of the first print (a tax bill keeps its style). */
function PrintDialog({ reprint, first, onClose, onPrint }: { reprint: boolean; first: PrintStyle | undefined; onClose: () => void; onPrint: (reasonCode: string, style: PrintStyle) => Promise<void> }) {
  const locked = reprint && first !== undefined;
  const [style, setStyle] = useState<PrintStyle>(() => (locked ? first : rememberedStyle()));
  const [reasonCode, setReasonCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (reprint && !reasonCode) return setError('Choose a reason.');
    setBusy(true);
    try {
      if (!locked) remember(style);
      await onPrint(reprint ? reasonCode! : 'first_print', style);
    } finally { setBusy(false); }
  };
  return (
    <Dialog
      title="Print invoice" isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose} isDisabled={busy}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void submit()}>Print</Button></>}
    >
      {reprint ? <p>This invoice was already printed. The new print is marked as a copy.</p> : null}
      {locked ? <p>First printed as {STYLE_LABEL[first]}. A reprint keeps that style.</p> : null}
      <RadioGroup<PrintStyle> label="Bill style" name="style" value={style} isDisabled={locked} onChange={setStyle} options={PRINT_STYLES.map((s) => ({ value: s, label: STYLE_LABEL[s] }))} />
      {reprint ? <Select label="Reason" name="reason_code" isRequired options={REPRINT_REASONS.map((r) => ({ value: r.code, label: r.display }))} {...(reasonCode ? { value: reasonCode } : {})} onChange={(v) => { setReasonCode(v); setError(undefined); }} /> : null}
      {error ? <p role="alert" className="lims-error">{error}</p> : null}
    </Dialog>
  );
}

function PartialCreditDialog({ invoice, idempotencyKey, onClose, onDone, onFail }: { invoice: InvoiceDetail; idempotencyKey: string; onClose: () => void; onDone: (no: string) => void; onFail: (code: string) => void }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [amounts, setAmounts] = useState<Readonly<Record<string, FieldMoney | undefined>>>({});
  const [reasonCode, setReasonCode] = useState<string>();
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    if (picked.size === 0) return setError('Choose at least one line.');
    if (!reasonCode) return setError('Choose a reason.');
    const lines = [...picked].map((id) => ({ invoice_line_id: id, ...(amounts[id] ? { amount_paisa: amounts[id]!.amountPaisa } : {}) }));
    inFlight.current = true;
    try {
      const r = await issuePartialCreditNoteAction(invoice.id, { lines, reason_code: reasonCode, ...(reasonText ? { reason_text: reasonText } : {}) }, idempotencyKey);
      if (r.ok) onDone(r.data.credit_note_no);
      else onFail(r.code);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog title="Partial credit note" isOpen onClose={onClose} size="lg">
      <Form onSubmit={submit}>
        {error ? <p role="alert">{error}</p> : null}
        {invoice.lines.map((l) => {
          const left = l.net.amount_paisa - (l.credited?.amount_paisa ?? 0);
          return (
            <div key={l.id}>
              <Checkbox label={`${l.name} — ${formatNpr(left)} left to credit`} isDisabled={left <= 0} isSelected={picked.has(l.id)} onChange={(on) => { const n = new Set(picked); if (on) n.add(l.id); else n.delete(l.id); setPicked(n); setError(undefined); }} />
              {picked.has(l.id) ? <MoneyField label={`Amount to credit for ${l.name} (blank = all)`} name={`amount_${l.id}`} max={{ amountPaisa: left, currency: 'NPR' }} {...(amounts[l.id] ? { value: amounts[l.id]! } : {})} onChange={(v) => setAmounts({ ...amounts, [l.id]: v })} /> : null}
            </div>
          );
        })}
        <Select label="Reason" name="reason_code" isRequired options={CANCEL_REASONS.map((r) => ({ value: r.code, label: r.display }))} {...(reasonCode ? { value: reasonCode } : {})} onChange={(v) => { setReasonCode(v); setError(undefined); }} />
        <TextField label="Details" name="reason_text" maxLength={500} value={reasonText} onChange={setReasonText} />
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Issue credit note</Button>
      </Form>
    </Dialog>
  );
}

function RefundDialog({ invoice, refundable, idempotencyKey, onClose, onDone, onFail }: { invoice: InvoiceDetail; refundable: number; idempotencyKey: string; onClose: () => void; onDone: () => void; onFail: (code: string) => void }) {
  const [method, setMethod] = useState<string>();
  const [amount, setAmount] = useState<FieldMoney | undefined>();
  const [reasonCode, setReasonCode] = useState<string>();
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current || !invoice.order_id) return;
    if (!method || !reasonCode || !amount || amount.amountPaisa < 1) return setError('Choose a method, an amount and a reason.');
    inFlight.current = true;
    try {
      const r = await requestRefundAction(invoice.order_id, { method_code: method, refund_amount_paisa: amount.amountPaisa, reason_code: reasonCode, ...(reasonText ? { reason_text: reasonText } : {}) }, idempotencyKey);
      if (r.ok) onDone();
      else onFail(r.code);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog title="Request refund" isOpen onClose={onClose} size="md">
      <Form onSubmit={submit}>
        {error ? <p role="alert">{error}</p> : null}
        <p>Refundable amount: {formatNpr(refundable)}</p>
        <p>A second finance user must approve this refund.</p>
        <Select label="Payment method" name="method_code" isRequired options={PAYMENT_METHODS.map((m) => ({ value: m.code, label: m.display }))} {...(method ? { value: method } : {})} onChange={setMethod} />
        <MoneyField label="Refund amount" name="refund_amount" isRequired max={{ amountPaisa: refundable, currency: 'NPR' }} {...(amount ? { value: amount } : {})} onChange={setAmount} />
        <Select label="Reason" name="reason_code" isRequired options={REFUND_REASONS.map((r) => ({ value: r.code, label: r.display }))} {...(reasonCode ? { value: reasonCode } : {})} onChange={setReasonCode} />
        <TextField label="Details" name="reason_text" maxLength={500} value={reasonText} onChange={setReasonText} />
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Send for approval</Button>
      </Form>
    </Dialog>
  );
}
