'use client';
// 04-UI-UX §4.2.4 dialogs of the Stains tab: [Order stain], Complete, Cancel (free-text reason required), Link add-on item. Writes carry the order's version in If-Match
// and an Idempotency-Key; the client checks are hints, the API re-checks everything (REQ-SEC-081).
// LD-140 (2026-11-13, binding): kit components only; server text is rendered as text, never HTML (REQ-SEC-088).
import { useState } from 'react';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { cancelStainAction, completeStainAction, linkAddonAction, orderStainAction } from '../../server/actions.material';
import type { CaseDetail, CaseItem, StainOrder } from '../../server/types';
import { newKey } from '../common';
import { FormDialog } from './FormDialog';
import { useStains } from './useStains';

interface Shared { detail: CaseDetail; onClose: () => void; onMfa: () => void; onDone: () => void }
const IHC_NEEDS_BLOCK = 'IHC must be ordered on a block.';

export function OrderStainDialog({ detail, addons, onClose, onMfa, onDone }: Shared & { addons: readonly CaseItem[] }) {
  const stains = useStains().filter((s) => s.kind !== 'routine'); // routine stains come with the block, not as orders
  const [stain, setStain] = useState<string>();
  const [block, setBlock] = useState<string>();
  const [part, setPart] = useState<string>();
  const [note, setNote] = useState('');
  const [addon, setAddon] = useState<string>();
  const [blockError, setBlockError] = useState<string>();
  const blocks = detail.blocks.filter((b) => b.location_status !== 'discarded');
  return (
    <FormDialog
      title="Order stain"
      submitLabel="Order stain"
      status={detail.status}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!stain) return undefined;
        if (stains.find((s) => s.code === stain)?.kind === 'ihc' && !block) {
          setBlockError(IHC_NEEDS_BLOCK);
          return undefined;
        }
        setBlockError(undefined);
        const r = await orderStainAction(detail.id, { stain_code: stain, ...(block ? { block_id: block } : part ? { part_id: part } : {}), ...(note ? { note } : {}), ...(addon ? { addon_order_item_id: addon } : {}) }, newKey());
        if (r.ok) onDone();
        else return r;
        return undefined;
      }}
    >
      <Select label="Stain (required)" placeholder="Stain: none chosen" name="stain_code" isRequired options={stains.map((s) => ({ value: s.code, label: s.display }))} {...(stain ? { value: stain } : {})} onChange={setStain} />
      <Select
        label="Block"
        placeholder="Block: none chosen"
        name="block_id"
        options={blocks.map((b) => ({ value: b.id, label: b.location_status === 'sent_out' ? `${b.label} — Sent out — complete after return` : b.label }))}
        {...(block ? { value: block } : {})}
        {...(blockError ? { error: blockError } : {})}
        onChange={(v) => { setBlock(v); setBlockError(undefined); }}
      />
      <Select label="Part" placeholder="Part: none chosen" name="part_id" description="For special stains when no block is chosen" options={detail.parts.map((p) => ({ value: p.id, label: `Part ${p.letter}${p.site_text ? ` — ${p.site_text}` : ''}` }))} {...(part ? { value: part } : {})} onChange={setPart} />
      <TextArea label="Note" name="note" maxLength={500} value={note} onChange={setNote} />
      <Select label="Billed add-on item" name="addon_order_item_id" options={addons.map((a) => ({ value: a.order_item_id, label: a.test_name }))} {...(addon ? { value: addon } : {})} onChange={setAddon} />
    </FormDialog>
  );
}

export function CompleteStainDialog({ detail, order, onClose, onMfa, onDone }: Shared & { order: StainOrder }) {
  const [count, setCount] = useState<number | undefined>(1);
  const [lot, setLot] = useState('');
  const [performed, setPerformed] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <FormDialog
      title={`Complete ${order.stain_display}`}
      submitLabel="Complete"
      status={detail.status}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (count === undefined) return undefined;
        if (performed && Date.parse(performed) > Date.now()) {
          setError('Performed at cannot be in the future.');
          return undefined;
        }
        setError(undefined);
        const r = await completeStainAction(order.id, order.version, { slide_count: count, ...(lot ? { reagent_lot: lot } : {}), ...(performed ? { performed_at: performed } : {}) }, newKey());
        if (r.ok) onDone();
        else return r;
        return undefined;
      }}
    >
      <IntegerField label="Slides made" name="slide_count" min={1} max={20} isRequired {...(count !== undefined ? { value: count } : {})} onChange={setCount} />
      <TextField label="Reagent lot" name="reagent_lot" maxLength={64} value={lot} onChange={setLot} />
      <DateTimePicker label="Performed at" name="performed_at" description="Leave empty for now" {...(performed ? { value: performed as never } : {})} {...(error ? { error } : {})} onChange={(v) => setPerformed(v)} />
    </FormDialog>
  );
}

export function CancelStainDialog({ detail, order, onClose, onMfa, onDone }: Shared & { order: StainOrder }) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      title={`Cancel ${order.stain_display}`}
      submitLabel="Cancel stain order"
      danger
      status={detail.status}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        const r = await cancelStainAction(order.id, order.version, reason, newKey());
        if (r.ok) onDone();
        else return r;
        return undefined;
      }}
    >
      <p>Cancelling stops this stain order. Say why.</p>
      <TextField label="Reason" name="reason_text" maxLength={500} isRequired value={reason} onChange={setReason} />
    </FormDialog>
  );
}

export function LinkAddonDialog({ detail, order, addons, onClose, onMfa, onDone }: Shared & { order: StainOrder; addons: readonly CaseItem[] }) {
  const [item, setItem] = useState<string>();
  return (
    <FormDialog
      title="Link add-on item"
      submitLabel="Link"
      status={detail.status}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!item) return undefined;
        const r = await linkAddonAction(order.id, order.version, item, newKey());
        if (r.ok) onDone();
        else return r;
        return undefined;
      }}
    >
      <Select label="Add-on item (required)" placeholder="Add-on item: none chosen" name="order_item_id" isRequired options={addons.map((a) => ({ value: a.order_item_id, label: a.test_name }))} {...(item ? { value: item } : {})} onChange={setItem} />
    </FormDialog>
  );
}
