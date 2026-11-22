'use client';
// SCR-10 Reprocess (E38): ConfirmDialog with a required coded reason, then a Dialog with the per-record outcome table (04-UI-UX §3).
// A retry with the same content reuses its Idempotency-Key, so a lost response never creates a second run. Mounted only while open.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
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
  // T0D-UIX-4 (LD-442): the kit DataTable; the header row stays when the list is empty (LD-353 rule 5).
  type Rec = (typeof records)[number];
  const columns: ColumnDef<Rec>[] = [
    { id: 'barcode', header: 'Barcode', isRowHeader: true, cell: (r) => <span className="lims-mono">{r.sample_barcode ?? '—'}</span> },
    { id: 'code', header: 'Code', cell: (r) => r.instrument_analyte_code ?? '—' },
    { id: 'outcome', header: 'Outcome', cell: (r) => portOutcomeText(r) },
  ];
  return <DataTable<Rec> caption="Outcome per record" columns={columns} rows={records} getRowId={(r) => r.id} density="regular" emptyState={{ title: 'No records were produced.' }} />;
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
