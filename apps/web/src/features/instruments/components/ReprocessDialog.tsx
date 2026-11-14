'use client';
// SCR-10 Reprocess (E38): ConfirmDialog with a required coded reason, then a Dialog with the per-record outcome table (04-UI-UX §3).
// A retry with the same content reuses its Idempotency-Key, so a lost response never creates a second run. Mounted only while open.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { reprocessInstrumentMessageAction } from '../server/actions';
import { REPROCESS_REASONS, REPROCESS_REASONS_SET, MESSAGE_REASON_TEXT_MAX, type MessageRecord, type ReprocessResult } from '../server/messages';
import { portOutcomeText } from './MessageLabels';

/** [CONV] texts: the spec gives none for these API problems; the code is always shown so support can quote it. */
export function messageProblemText(code: string, what: string): string {
  if (code === 'instruments.reprocess_not_allowed') return `${what}: this message cannot be reprocessed in its current state (${code}).`;
  if (code === 'instruments.driver_not_available') return `${what}: the instrument's driver is not available (${code}).`;
  return `${what} (${code}).`;
}

/** Record barcode + C5 port outcome text per record (the same table for reprocess and re-match). */
export function OutcomeTable({ records }: { records: readonly Pick<MessageRecord, 'id' | 'sample_barcode' | 'instrument_analyte_code' | 'port_outcome' | 'port_reason_code'>[] }) {
  if (!records.length) return <p>No records were produced.</p>;
  return (
    <table className="lims-table">
      <caption className="lims-visually-hidden">Outcome per record</caption>
      <thead>
        <tr><th scope="col">Barcode</th><th scope="col">Code</th><th scope="col">Outcome</th></tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <tr key={r.id}>
            <td className="lims-mono">{r.sample_barcode ?? '—'}</td>
            <td>{r.instrument_analyte_code ?? '—'}</td>
            <td>{portOutcomeText(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Same request content → same Idempotency-Key (a retry is a replay); changed content → a fresh key, so an edited retry is not a key conflict. */
export function useIdempotencyKey() {
  const last = useRef<{ sig: string; key: string } | undefined>(undefined);
  return (sig: string) => {
    if (last.current?.sig !== sig) last.current = { sig, key: crypto.randomUUID() };
    return last.current.key;
  };
}

export function ReprocessDialog({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const router = useRouter();
  const keyFor = useIdempotencyKey();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ReprocessResult>();

  if (result) {
    return (
      <Dialog title="Reprocess result" isOpen onClose={onClose} size="lg">
        {result.preview ? <p>Preview only: nothing was sent to the laboratory.</p> : null}
        <OutcomeTable records={result.records} />
      </Dialog>
    );
  }
  return (
    <ConfirmDialog
      title="Reprocess message"
      isOpen
      confirmLabel="Reprocess"
      onCancel={onClose}
      requireReason={{ codedSet: REPROCESS_REASONS_SET, options: REPROCESS_REASONS, freeText: { maxLength: MESSAGE_REASON_TEXT_MAX, isRequired: false } }}
      body={
        <>
          <p>The original message is parsed again with the current driver and sent to the laboratory. Results already applied are not duplicated; approved results are never changed.</p>
          {error ? (
            <div role="alert">
              <Banner tone="danger" title={error} />
            </div>
          ) : null}
        </>
      }
      onConfirm={async ({ reasonCode, reasonText }) => {
        if (!reasonCode) return;
        setError(undefined);
        const r = await reprocessInstrumentMessageAction(messageId, { reasonCode, ...(reasonText ? { reasonText } : {}) }, keyFor(`${reasonCode}|${reasonText ?? ''}`));
        if (r.ok) {
          setResult(r.data);
          router.refresh();
        } else setError(messageProblemText(r.code, 'Could not reprocess the message'));
      }}
    />
  );
}
