'use client';
// 04-UI-UX §2.3.1 Request refund dialog (opened from the intent detail). The Idempotency-Key is made when the dialog opens and re-used on retry (AC-PG-09.8).
// The amount sent is integer paisa; the server re-checks every bound, this screen only saves a round trip.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { Dialog } from '@lims/ui/components/Dialog';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { failText } from '../errors';
import { nprText } from '../labels';
import { createRefundAction } from '../server/actions';
import type { CodedValue, PaymentIntentDetail, PaymentMoney } from '../types';

export interface RefundRequestDialogProps {
  intent: PaymentIntentDetail;
  /** "Order overpaid by" (C4 refundable rule). Absent = unknown: the server still enforces it. */
  overpaid?: PaymentMoney | undefined;
  refundReasons: readonly CodedValue[];
  isOpen: boolean;
  onClose: () => void;
}
interface Errors { amount?: string; reason?: string; details?: string }

const npr = (paisa: number): Money => ({ amountPaisa: paisa, currency: 'NPR' });

export function RefundRequestDialog({ intent, overpaid, refundReasons, isOpen, onClose }: RefundRequestDialogProps) {
  const router = useRouter();
  const toast = useToast();
  const captured = intent.verified_amount?.amount_paisa ?? intent.amount.amount_paisa;
  const refunded = intent.refunded_amount?.amount_paisa ?? 0;
  const refundable = Math.max(0, overpaid ? Math.min(captured - refunded, overpaid.amount_paisa) : captured - refunded);
  const tooMuch = `More than can be refunded (max ${nprText({ amount_paisa: refundable, currency: 'NPR' })})`;

  const [key, setKey] = useState('');
  const [amount, setAmount] = useState<Money | undefined>(npr(refundable));
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    setKey(globalThis.crypto.randomUUID()); // one key per opened dialog: a retry replays, never doubles
    setAmount(npr(refundable));
    setReason('');
    setDetails('');
    setErrors({});
    setBanner('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const submit = async () => {
    if (inFlight.current || !key) return;
    const e: Errors = {};
    if (!amount || amount.amountPaisa < 1) e.amount = 'Enter an amount of at least NPR 0.01';
    else if (amount.amountPaisa > refundable) e.amount = tooMuch;
    const picked = refundReasons.find((r) => r.code === reason);
    if (!reason) e.reason = 'Enter Reason';
    else if (picked?.requires_text && !details.trim()) e.details = 'Enter Details';
    setErrors(e);
    if (e.amount || e.reason || e.details) return;
    inFlight.current = true;
    setBusy(true);
    setBanner('');
    try {
      const res = await createRefundAction(intent.id, amount!.amountPaisa, reason, details.trim() || undefined, key);
      if (res.ok) {
        toast.show({ tone: 'success', title: 'Refund requested. A second person must approve it.' });
        router.refresh();
        onClose();
      } else if (res.code === 'payments.refund_exceeds_captured') setErrors({ amount: tooMuch });
      else if (res.code === 'payments.refund_not_allowed') setBanner('A refund is already in progress for this payment.');
      else setBanner(failText(res));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  };
  const helper = `Refundable now: ${nprText({ amount_paisa: refundable, currency: 'NPR' })} (captured ${nprText({ amount_paisa: captured, currency: 'NPR' })}, already refunded ${nprText({ amount_paisa: refunded, currency: 'NPR' })}${overpaid ? `, order overpaid by ${nprText(overpaid)}` : ''})`;

  return (
    <Dialog
      title="Request refund" isOpen={isOpen} onClose={onClose}
      footer={<><Button variant="ghost" onPress={onClose} isDisabled={busy}>Cancel</Button><Button variant="primary" shortcut="Ctrl+Enter" isLoading={busy} onPress={() => void submit()}>Request refund</Button></>}
    >
      <div onKeyDown={onKeyDown}>
        {banner ? <div role="alert"><Banner tone="danger" title={banner} /></div> : null}
        <MoneyField label="Amount" name="refund_amount" isRequired description={helper} {...(amount ? { value: amount } : {})} onChange={setAmount} {...(errors.amount ? { error: errors.amount } : {})} />
        <CodedSelect
          label="Reason" name="reason_code" codedSet="payments.refund_reasons" isRequired {...(reason ? { value: reason } : {})} onChange={setReason}
          options={refundReasons.map((r) => ({ code: r.code, display: r.display, isActive: r.is_active !== false }))} {...(errors.reason ? { error: errors.reason } : {})}
        />
        <TextArea label="Details" name="reason_text" maxLength={500} value={details} onChange={setDetails} {...(errors.details ? { error: errors.details } : {})} />
      </div>
    </Dialog>
  );
}
