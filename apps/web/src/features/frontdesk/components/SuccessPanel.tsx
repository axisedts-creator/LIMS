'use client';
// 04-UI-UX §3.4 success panel: registration no, invoice (auto-print for cash), paid/due, SMS text, labels (08 A13 D-4), Print copy / Open order / New registration.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { InvoicePrintFrame } from '@/features/billing/components/print/InvoicePrintView';
import type { InvoicePrintDocument } from '@/features/billing/server/types';
import { newKey } from '../forms/draft';
import { printInvoiceAction, requestLabelPrintsAction } from '../server/actions';
import type { RegistrationResult } from '../server/types';

const LABEL_RETRY_MS = 1000; // 08 A13 D-4: retried every 1 s ...
const LABEL_GIVE_UP_MS = 10_000; // ... up to 10 s
/** C5 route staff.lab.order_labels = /lab/orders/{order_id}/labels (packages/shared-ts routes/generated.ts; the package has no export for apps/web yet — CR FD-T13-routes). */
const labelsPath = (orderId: string) => `/lab/orders/${orderId}/labels`;

const SMS: Record<string, string> = {
  queued: 'SMS queued',
  suppressed_no_consent: 'SMS not sent: no consent',
  suppressed_channel_disabled: 'SMS disabled for this lab',
  suppressed_no_contact: 'SMS not sent: no mobile number',
};
type Labels = { s: 'off' } | { s: 'preparing' } | { s: 'ready' } | { s: 'error'; text: string };
type Printed = 'no' | 'printing' | 'original' | 'failed';

export function SuccessPanel({ result, onNew, onOpenOrder, retryLabelsRef }: { result: RegistrationResult; onNew: () => void; onOpenOrder: () => void; retryLabelsRef: { current: (() => void) | null } }) {
  const invoice = result.invoice;
  const [printed, setPrinted] = useState<Printed>('no');
  const [doc, setDoc] = useState<InvoicePrintDocument | null>(null);
  const [labels, setLabels] = useState<Labels>({ s: result.label_print?.autoprint ? 'preparing' : 'off' });
  const alive = useRef(true);
  const run = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; run.current++; }; }, []);

  const print = useCallback(async (reason: string, original: boolean) => {
    if (!invoice) return;
    setPrinted('printing');
    const r = await printInvoiceAction(invoice.id, reason, newKey());
    if (!alive.current) return;
    if (!r.ok) { setPrinted('failed'); return; }
    // The B3 call above records print_count before anything prints; only a complete document is sent to the print frame.
    const d = r.data.document as InvoicePrintDocument | undefined;
    if (d && Array.isArray((d as { lines?: unknown }).lines)) setDoc({ ...d, print_no: r.data.print_no });
    setPrinted(original ? 'original' : 'no');
  }, [invoice]);

  const started = useRef(false);
  useEffect(() => { // auto-print the invoice once (cash orders have one; credit orders do not)
    if (started.current || !invoice) return;
    started.current = true;
    void print('first_print', true);
  }, [invoice, print]);

  const prepareLabels = useCallback(async () => {
    const my = ++run.current;
    const t0 = Date.now();
    setLabels({ s: 'preparing' });
    for (;;) {
      const r = await requestLabelPrintsAction(result.order.id); // x-idempotency: none
      if (my !== run.current || !alive.current) return;
      if (r.ok) return setLabels({ s: 'ready' });
      if (r.code !== 'common.version_conflict') return setLabels({ s: 'error', text: r.title ?? 'Labels could not be prepared.' });
      if (Date.now() - t0 >= LABEL_GIVE_UP_MS) return setLabels({ s: 'error', text: 'Labels are not ready yet.' });
      await new Promise((res) => setTimeout(res, LABEL_RETRY_MS));
      if (my !== run.current || !alive.current) return;
    }
  }, [result.order.id]);

  const labelStarted = useRef(false);
  useEffect(() => {
    if (labelStarted.current || !result.label_print?.autoprint) return;
    labelStarted.current = true;
    void prepareLabels();
  }, [prepareLabels, result.label_print?.autoprint]);
  useLayoutEffect(() => { // Alt+L (owned by the form's shortcut map) retries only after an error; layout effect so the key works the moment the error shows
    retryLabelsRef.current = labels.s === 'error' ? () => void prepareLabels() : null;
    return () => { retryLabelsRef.current = null; };
  }, [labels.s, prepareLabels, retryLabelsRef]);

  const paid = result.balance?.paid, due = result.balance?.due;
  const sms = SMS[result.notifications?.registration_sms ?? ''];
  return (
    <Card title="Registered">
      <div role="status">
        <p className="lims-reg-no" style={{ fontSize: '2rem', fontWeight: 700, userSelect: 'all' }}>{result.order.registration_no}</p>
        {invoice ? (
          <p>
            <span>{invoice.invoice_no}</span>{' '}
            {printed === 'original' ? <span>Printed (original)</span> : printed === 'failed' ? <span>Not printed</span> : printed === 'printing' ? <span>Printing…</span> : null}
          </p>
        ) : null}
        {paid && due ? (
          <dl style={{ display: 'flex', gap: 24 }}>
            <div><dt>Paid</dt><dd><MoneyText value={{ amountPaisa: paid.amount_paisa, currency: 'NPR' }} /></dd></div>
            <div><dt>Due</dt><dd><MoneyText value={{ amountPaisa: due.amount_paisa, currency: 'NPR' }} /></dd></div>
          </dl>
        ) : null}
        {sms ? <p>{sms}</p> : null}
        {labels.s === 'preparing' ? <p>Preparing labels…</p> : labels.s === 'ready' ? <p>Labels ready — printing</p> : null}
      </div>
      {labels.s === 'error' ? (
        <Banner tone="danger" title={labels.text} action={{ label: 'Retry (Alt+L)', onPress: () => void prepareLabels() }} />
      ) : null}
      {labels.s === 'ready' ? (
        <iframe
          title="Labels"
          aria-hidden="true"
          tabIndex={-1}
          src={labelsPath(result.order.id)}
          sandbox="allow-same-origin allow-scripts allow-modals"
          className="lims-printframe"
          onLoad={(e) => { try { e.currentTarget.contentWindow?.focus(); e.currentTarget.contentWindow?.print(); } catch { /* a print failure must not block the desk */ } }}
        />
      ) : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
        {invoice ? <Button onPress={() => void print('customer_copy', false)} isDisabled={printed === 'printing'}>Print copy</Button> : null}
        <Button onPress={onOpenOrder} shortcut="Alt+G">Open order</Button>
        <Button variant="primary" onPress={onNew} shortcut="Ctrl+Shift+N">New registration</Button>
      </div>
      {doc ? <InvoicePrintFrame document={doc} isOpen onDone={() => setDoc(null)} /> : null}
    </Card>
  );
}
