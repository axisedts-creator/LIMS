'use client';
// 04-UI-UX §4.4 Movement dialog (case workspace + tracking basket): read-only item list, Movement radios, Location / Destination / Reason / Note.
// Store needs a Location, Send out a Destination and a Reason, Discard a Reason (the API enforces the same rules, TRD M11). Discard asks first (ConfirmDialog, danger).
// One request per object_kind (and per 200 ids, REQ-SEC-100), each with its own Idempotency-Key. Outcomes come back per id: the caller keeps only the ones that failed.
// LD-140 (2026-11-13, binding): kit components only; no hex colours, pixel radii or inline style objects; one primary button (the submit button of this dialog).
import { useRef, useState } from 'react';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { recordMovementsAction } from '../../server/actions.material';
import type { MovementInput, MovementKind, MovementReason } from '../../server/types';
import { FailNotice, newKey, type Fail } from '../common';

export interface MovementItem { id: string; label: string; kind: 'block' | 'slide' }
export interface MovementDone { recorded: number; failed: { id: string; label: string; outcome: string }[] }

const MOVEMENT_OPTIONS: readonly { value: MovementKind; label: string }[] = [
  { value: 'stored', label: 'Store' }, { value: 'retrieved', label: 'Retrieve' }, { value: 'sent_out', label: 'Send out' }, { value: 'returned', label: 'Return' }, { value: 'discarded', label: 'Discard' },
];
const REASON_OPTIONS: readonly { value: MovementReason; label: string }[] = [
  { value: 'second_opinion', label: 'Second opinion' }, { value: 'external_stain', label: 'External stain' }, { value: 'consultation', label: 'Consultation' },
  { value: 'retention_expired', label: 'Retention period ended' }, { value: 'other', label: 'Other' },
];
export const REASON_LABEL: Record<string, string> = Object.fromEntries(REASON_OPTIONS.map((o) => [o.value, o.label]));
const BATCH = 200; // REQ-SEC-100: the API takes at most 200 ids per call

interface Props { items: readonly MovementItem[]; isOpen: boolean; onClose: () => void; onMfa: () => void; onDone: (r: MovementDone) => void }

/** Mounted only while open, so every opening starts with an empty form. */
export const MovementDialog = (p: Props) => (p.isOpen ? <MovementForm {...p} /> : null);

function MovementForm({ items, isOpen, onClose, onMfa, onDone }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const [movement, setMovement] = useState<MovementKind>();
  const [location, setLocation] = useState('');
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState<MovementReason>();
  const [note, setNote] = useState('');
  const [fail, setFail] = useState<Fail>();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const finish = (outcomes: Map<string, string>) => {
    const failed = items.filter((i) => outcomes.has(i.id) && outcomes.get(i.id) !== 'recorded').map((i) => ({ id: i.id, label: i.label, outcome: outcomes.get(i.id)! }));
    onDone({ recorded: [...outcomes.values()].filter((o) => o === 'recorded').length, failed });
  };

  const send = async () => {
    if (!movement || pending) return;
    setFail(undefined);
    setPending(true);
    try {
      const outcomes = new Map<string, string>();
      for (const kind of ['block', 'slide'] as const) {
        const ids = items.filter((i) => i.kind === kind).map((i) => i.id);
        for (let at = 0; at < ids.length; at += BATCH) {
          const input: MovementInput = {
            object_kind: kind, object_ids: ids.slice(at, at + BATCH), movement,
            ...(location ? { location_text: location } : {}),
            ...(destination ? { destination_text: destination } : {}),
            ...(reason ? { reason_code: reason } : {}),
            ...(note ? { note } : {}),
          };
          const r = await recordMovementsAction(input, newKey());
          if (!r.ok) {
            // Earlier batches are already recorded: report them so the caller does not offer those items again.
            if (r.code === 'auth.mfa_required') onMfa();
            else setFail(r);
            if (outcomes.size) finish(outcomes);
            return;
          }
          for (const o of r.data.results) outcomes.set(o.id, o.outcome);
        }
      }
      finish(outcomes);
    } finally {
      setPending(false);
    }
  };

  const submit = () => (movement === 'discarded' ? setConfirming(true) : send());
  const problem = fail?.errors?.length ? { errors: fail.errors.map((e) => ({ ...(e.path ? { path: e.path } : {}), message: 'Check this value.' })) } : undefined;

  return (
    <>
      <Dialog
        title="Record movement"
        isOpen={isOpen}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onPress={onClose} isDisabled={pending}>Cancel</Button>
            <Button variant="primary" isLoading={pending} onPress={() => body.current?.querySelector('form')?.requestSubmit()}>Record movement</Button>
          </>
        }
      >
        <div ref={body}>
          <FailNotice fail={fail} />
          <p className="lims-label" id="movement-items">Items ({items.length})</p>
          <ul aria-labelledby="movement-items">
            {items.map((i) => <li key={i.id} className="lims-mono">{i.label}</li>)}
          </ul>
          <Form onSubmit={submit} {...(problem ? { problem } : {})}>
            <RadioGroup label="Movement" name="movement" isRequired options={MOVEMENT_OPTIONS} {...(movement ? { value: movement } : {})} onChange={setMovement} />
            <TextField label="Location" name="location_text" maxLength={120} isRequired={movement === 'stored'} description="For example: Block cabinet 3, drawer 2" value={location} onChange={setLocation} />
            <TextField label="Destination" name="destination_text" maxLength={200} isRequired={movement === 'sent_out'} value={destination} onChange={setDestination} />
            <Select label="Reason" name="reason_code" isRequired={movement === 'sent_out' || movement === 'discarded'} options={REASON_OPTIONS} {...(reason ? { value: reason } : {})} onChange={setReason} />
            <TextArea label="Note" name="note" maxLength={500} value={note} onChange={setNote} />
          </Form>
        </div>
      </Dialog>
      <ConfirmDialog
        title="Discard"
        tone="danger"
        confirmLabel="Discard"
        isOpen={confirming}
        onCancel={() => setConfirming(false)}
        body="Discarded blocks and slides can't be used again."
        onConfirm={async () => {
          setConfirming(false);
          await send();
        }}
      />
    </>
  );
}
