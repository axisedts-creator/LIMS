'use client';
// 04-UI-UX §4.6 [New batch] Dialog: Assay (Select, required), Kit name (<=120), Kit lot (<=64), Kit expiry (DatePicker), Instrument (<=120), Run at (DateTimePicker),
// Capacity (IntegerField 1-384, default 96). POST /batches with an Idempotency-Key; empty optionals are omitted. The API re-checks every limit (these are hints).
// Mounted by the list only while open, so every opening starts empty. LD-140 (2026-11-13, binding): kit components only; the submit button is the dialog's primary button.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DateTimePicker, type DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createBatchAction } from '../../server/actions.molecular';
import type { Assay, BatchInput } from '../../server/types';
import { newKey } from '../common';
import { FormDialog } from '../material/FormDialog';

const DEFAULT_CAPACITY = 96;
const MIN_EXPIRY = '2000-01-01' as IsoDate;
type IsoUtc = NonNullable<DateTimePickerProps['value']>;

export function NewBatchDialog({ assays, onClose, onMfa }: { assays: readonly Assay[]; onClose: () => void; onMfa: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [assay, setAssay] = useState<string>();
  const [kitName, setKitName] = useState('');
  const [kitLot, setKitLot] = useState('');
  const [expiry, setExpiry] = useState<IsoDate>();
  const [instrument, setInstrument] = useState('');
  const [runAt, setRunAt] = useState<IsoUtc>();
  const [capacity, setCapacity] = useState<number | undefined>(DEFAULT_CAPACITY);

  return (
    <FormDialog
      title="New batch"
      submitLabel="Create batch"
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!assay || capacity === undefined || !Number.isInteger(capacity) || capacity < 1 || capacity > 384) return undefined; // the fields show why; nothing is sent
        const input: BatchInput = {
          assay_code: assay,
          ...(kitName ? { kit_name: kitName } : {}),
          ...(kitLot ? { kit_lot: kitLot } : {}),
          ...(expiry ? { kit_expiry_on: expiry } : {}),
          ...(instrument ? { instrument_text: instrument } : {}),
          ...(runAt ? { run_at: runAt } : {}),
          capacity,
        };
        const r = await createBatchAction(input, newKey());
        if (!r.ok) return r;
        toast.show({ tone: 'success', title: 'Batch created' });
        onClose();
        router.push(`/anatomic/batches/${r.data.id}`);
        return undefined;
      }}
    >
      <Select
        label="Assay" name="assay_code" isRequired description="Required. Active assays only."
        options={assays.filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.display }))} {...(assay ? { value: assay } : {})} onChange={setAssay}
      />
      <TextField label="Kit name" name="kit_name" maxLength={120} value={kitName} onChange={setKitName} />
      <TextField label="Kit lot" name="kit_lot" maxLength={64} value={kitLot} onChange={setKitLot} />
      <DatePicker label="Kit expiry" name="kit_expiry_on" min={MIN_EXPIRY} {...(expiry ? { value: expiry } : {})} onChange={setExpiry} />
      <TextField label="Instrument" name="instrument_text" maxLength={120} value={instrument} onChange={setInstrument} />
      <DateTimePicker label="Run at" name="run_at" {...(runAt ? { value: runAt } : {})} onChange={setRunAt} />
      <IntegerField label="Capacity" name="capacity" min={1} max={384} description="Positions in the batch, 1 to 384." {...(capacity !== undefined ? { value: capacity } : {})} onChange={setCapacity} />
    </FormDialog>
  );
}
