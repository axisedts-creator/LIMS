'use client';
// SCR-10 Re-match (E39): the current barcode is shown read-only; the new one is typed or scanned and must differ. It travels only in the POST body
// (through a server action) — never in a URL, header, history or storage — and is never echoed in an error. Mounted only while open.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { rematchInstrumentRecordAction } from '../server/actions';
import { MESSAGE_REASON_TEXT_MAX, REPROCESS_REASONS, SAMPLE_BARCODE_RE, type MessageRecord, type RematchResult } from '../server/messages';
import { OutcomeTable, messageProblemText, useIdempotencyKey } from './ReprocessDialog';

export function RematchDialog({ record, onClose }: { record: Pick<MessageRecord, 'id' | 'sample_barcode'>; onClose: () => void }) {
  const router = useRouter();
  const keyFor = useIdempotencyKey();
  const field = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false); // one request per click: a double click must not send a second re-match
  const [reason, setReason] = useState<string>('barcode_keypad_error');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RematchResult>();

  const submit = async () => {
    if (inFlight.current) return;
    const typed = (field.current?.querySelector('input')?.value ?? '').trim().toUpperCase();
    if (!SAMPLE_BARCODE_RE.test(typed)) { setFieldError(typed ? "This doesn't look like a sample barcode" : 'Enter the new barcode.'); return; } // [CONV] empty text
    if (typed === record.sample_barcode) { setFieldError('The new barcode must differ from the current one.'); return; }
    setFieldError(undefined);
    setError(undefined);
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await rematchInstrumentRecordAction(record.id, { sampleBarcode: typed, reasonCode: reason, ...(note ? { reasonText: note } : {}) }, keyFor(`${typed}|${reason}|${note}`));
      if (r.ok) {
        setResult(r.data);
        router.refresh();
      } else setError(messageProblemText(r.code, 'Could not re-match the record'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Dialog title="Re-match result" isOpen onClose={onClose} size="lg">
        <OutcomeTable records={[result.record]} />
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Re-match record"
      isOpen
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>Cancel</Button>
          <Button variant="primary" isLoading={busy} onPress={() => void submit()}>Re-match</Button>
        </>
      }
    >
      {error ? (
        <div role="alert">
          <Banner tone="danger" title={error} />
        </div>
      ) : null}
      <p>Current barcode: <span className="lims-mono">{record.sample_barcode ?? '—'}</span></p>
      <div ref={field}>
        <BarcodeInput label="New barcode" name="new_sample" autoFocus pattern={SAMPLE_BARCODE_RE} clearAfterScan={false} onScan={() => setFieldError(undefined)} {...(fieldError ? { error: fieldError } : {})} />
      </div>
      <Select label="Reason" name="reason_code" value={reason} options={REPROCESS_REASONS.map((r) => ({ value: r.code, label: r.display }))} onChange={setReason} />
      <TextArea label="Note" name="reason_text" maxLength={MESSAGE_REASON_TEXT_MAX} rows={3} value={note} onChange={setNote} />
    </Dialog>
  );
}
