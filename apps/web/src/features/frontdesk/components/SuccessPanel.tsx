'use client';
// 04-UI-UX §3.4 success panel: registration no, invoice (auto-print for cash), paid/due, SMS text, labels (08 A13 D-4), Print copy / Open order / New registration.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { InvoicePrintFrame } from '@/features/billing/components/print/InvoicePrintView';
import { ReceiptPrintFrame } from '@/features/billing/components/print/ReceiptPrintView';
import type { ReceiptDocument } from '@/features/billing/server/types';
// T0D-OFFLINE-3 (LD-322): an order saved offline shows its provisional numbers (final after sync), the Pending sync badge and the lab codes
import { DocNumber, PendingSyncBadge } from '@/core/offline/ui/OfflineParts';
import { t } from '@/core/i18n/messages';
import type { InvoicePrintDocument } from '@/features/billing/server/types';
import { newKey } from '../forms/draft';
import { printInvoiceAction, requestLabelPrintsAction } from '../server/actions';
import type { RegistrationResult } from '../server/types';
import './frontdesk.css';

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
/** T0D-OFFLINE-3: what the device knows of an order saved offline; receipts print from it, the invoice prints once synced */
export interface OfflineSaved { receipts: ReceiptDocument[]; lab_codes: { orderable_id: string; value: string; provisional: boolean; mark?: string }[]; patient_code?: string }

export function SuccessPanel({ result, onNew, onOpenOrder, retryLabelsRef, offline }: { result: RegistrationResult; onNew: () => void; onOpenOrder: () => void; retryLabelsRef: { current: (() => void) | null }; offline?: OfflineSaved }) {
  const invoice = offline ? undefined : result.invoice; // offline: no server print; the receipts print locally below
  const [receipt, setReceipt] = useState<ReceiptDocument | null>(offline?.receipts[0] ?? null);
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

  if (offline) {
    return (
      <Card title="Registered">
        <div role="status">
          <p>{t('offline.saved_offline')} <PendingSyncBadge id={result.order.id} /></p>
          {offline.patient_code ? <p>Patient id <DocNumber value={offline.patient_code} /></p> : null}
          {result.invoice ? <p>Invoice <DocNumber value={result.invoice.invoice_no} /></p> : null}
          {offline.receipts.map((x) => <p key={x.receipt_no}>Receipt <DocNumber value={x.receipt_no} /></p>)}
          {offline.lab_codes.length ? <p>Lab codes {offline.lab_codes.map((l) => (l.provisional ? `${l.value} PENDING` : l.value)).join(', ')}</p> : null}
        </div>
        <div className="lims-reg-actions">
          {offline.receipts.length ? <Button onPress={() => setReceipt(offline.receipts[0]!)}>Print copy</Button> : null}
          <Button variant="primary" onPress={onNew} shortcut="Ctrl+Shift+N">New registration</Button>
        </div>
        {receipt ? <ReceiptPrintFrame receipt={receipt} isOpen onDone={() => setReceipt(null)} /> : null}
      </Card>
    );
  }
  const paid = result.balance?.paid, due = result.balance?.due;
  const sms = SMS[result.notifications?.registration_sms ?? ''];
  return (
    <Card title="Registered">
      <div role="status">
        <p className="lims-reg-no">{result.order.registration_no}</p>
        {invoice ? (
          <p>
            <DocNumber value={invoice.invoice_no} />{' '}
            {printed === 'original' ? <span>Printed (original)</span> : printed === 'failed' ? <span>Not printed</span> : printed === 'printing' ? <span>Printing…</span> : null}
          </p>
        ) : null}
        {paid && due ? (
          // T0D-UIX-4 (LD-442): kit DescriptionList, two columns keep paid and due side by side
          <DescriptionList columns={2} items={[
            { term: 'Paid', value: <MoneyText value={{ amountPaisa: paid.amount_paisa, currency: 'NPR' }} /> },
            { term: 'Due', value: <MoneyText value={{ amountPaisa: due.amount_paisa, currency: 'NPR' }} /> },
          ]} />
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
      <div className="lims-reg-actions">
        {invoice ? <Button onPress={() => void print('customer_copy', false)} isDisabled={printed === 'printing'}>Print copy</Button> : null}
        <Button onPress={onOpenOrder} shortcut="Alt+G">Open order</Button>
        <Button variant="primary" onPress={onNew} shortcut="Ctrl+Shift+N">New registration</Button>
      </div>
      {doc ? <InvoicePrintFrame document={doc} isOpen onDone={() => setDoc(null)} /> : null}
    </Card>
  );
}
