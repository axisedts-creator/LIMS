'use client';
// 04-UI-UX §3.2 observation dialog (AC-04.1 … AC-04.5, UI side). LD-140 (2026-11-13): kit components only. The UI never decides culture state: it posts, the server
// moves the culture (first growth read -> growth_detected) and the page refreshes. A correction is a NEW observation carrying corrects_observation_id (AC-04.4);
// nothing is edited in place. Fields that do not belong to the chosen type are not sent (no stale hidden values). Free text goes out as typed (trimmed), never as HTML.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { FailNotice, asIso, type IsoUtc } from '../components/common';
import { recordObservationAction } from '../server/cultureActions';
import type { CultureDetailDto, ObservationDto, ObservationKind } from '../server/types';
import { toOptions } from './format';
import { useAttempt } from './useAttempt';
import { useCodes } from './useCodes';

export const KIND_LABEL: Record<ObservationKind, string> = { plate_read: 'Plate read', gram_stain: 'Gram stain', microscopy: 'Microscopy', other: 'Other' };
const KINDS = (Object.keys(KIND_LABEL) as ObservationKind[]).map((value) => ({ value, label: KIND_LABEL[value] }));

export function ObservationDialog({ culture, kind: first, correcting, onClose }: { culture: CultureDetailDto; kind: ObservationKind; correcting?: ObservationDto; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const attempt = useAttempt();
  const growthCodes = useCodes('growth_codes');
  const [kind, setKind] = useState<ObservationKind>(correcting?.kind ?? first);
  const [plate, setPlate] = useState<string | undefined>(correcting?.plate_id);
  const [growth, setGrowth] = useState<string | undefined>(correcting?.growth_code);
  const [quantity, setQuantity] = useState(correcting?.quantity_text ?? '');
  const [finding, setFinding] = useState(correcting?.finding_text ?? '');
  const [at, setAt] = useState<IsoUtc | undefined>(() => asIso(new Date().toISOString()));
  const [atErr, setAtErr] = useState<string>();
  const [reqErr, setReqErr] = useState<{ plate?: string | undefined; growth?: string | undefined }>({}); // "Choose …" texts (the kit's generic "Enter …" does not say to pick from a list)

  const isRead = kind === 'plate_read';
  const plates = culture.plates.filter((p) => p.status === 'active');

  const submit = async () => {
    // Observed at: not in the future; for a plate read not before the plates were planted (the API re-checks both).
    const planted = plates.find((p) => p.id === plate)?.planted_at ?? culture.planted_at;
    const err = !at ? 'Enter the time of the observation.' : Date.parse(at) > Date.now() ? 'Observed at cannot be in the future.' : isRead && planted && Date.parse(at) < Date.parse(planted) ? 'Observed at cannot be before the plates were planted.' : undefined;
    setAtErr(err);
    if (err || !at) return;
    setReqErr(isRead ? { ...(plate ? {} : { plate: 'Choose a plate.' }), ...(growth ? {} : { growth: 'Choose a growth result.' }) } : {});
    if (isRead ? !plate || !growth : finding.trim() === '') return;
    const data = await attempt.send((key) =>
      recordObservationAction(
        culture.id,
        {
          kind,
          ...(isRead ? { plate_id: plate!, growth_code: growth! } : { finding_text: finding.trim() }),
          ...(quantity.trim() ? { quantity_text: quantity.trim() } : {}),
          observed_at: at,
          ...(correcting ? { corrects_observation_id: correcting.id } : {}),
        },
        key,
      ),
    );
    if (!data) return;
    toast.show({ tone: 'success', title: correcting ? 'Correction recorded' : isRead ? 'Read recorded' : 'Observation recorded' });
    router.refresh();
    onClose();
  };

  return (
    <Dialog title={correcting ? 'Correct observation' : 'Record observation'} isOpen onClose={onClose} size="md">
      <FailNotice fail={attempt.fail} />
      <Form onSubmit={submit} {...(attempt.fail?.errors ? { problem: { errors: attempt.fail.errors } } : {})}>
        <RadioGroup<ObservationKind> label="Type" name="kind" isRequired value={kind} options={KINDS} onChange={(k) => { setKind(k); attempt.touch(); }} />
        {isRead ? (
          <>
            <Select<string>
              label="Plate"
              name="plate_id"
              placeholder="Plate…"
              {...(reqErr.plate ? { error: reqErr.plate } : {})}
              {...(plate ? { value: plate } : {})}
              options={plates.map((p) => ({ value: p.id, label: `Plate ${p.plate_no}` }))}
              onChange={(v) => { setPlate(v); setReqErr((e) => ({ ...e, plate: undefined })); attempt.touch(); }}
            />
            <CodedSelect label="Growth" name="growth_code" codedSet="micro.growth_codes" placeholder="Growth…" {...(reqErr.growth ? { error: reqErr.growth } : {})} {...(growth ? { value: growth } : {})} options={toOptions(growthCodes.rows)} onChange={(c) => { setGrowth(c); setReqErr((e) => ({ ...e, growth: undefined })); attempt.touch(); }} />
          </>
        ) : (
          <TextArea label="Finding" name="finding_text" isRequired maxLength={2000} rows={4} value={finding} onChange={(v) => { setFinding(v); attempt.touch(); }} />
        )}
        <TextField label="Quantity" name="quantity_text" maxLength={80} description="For example ≥10^5 CFU/mL" value={quantity} onChange={(v) => { setQuantity(v); attempt.touch(); }} />
        <DateTimePicker
          label="Observed at"
          name="observed_at"
          isRequired
          {...(at ? { value: at } : {})}
          {...(atErr ? { error: atErr } : {})}
          onChange={(v) => { setAt(v); setAtErr(undefined); attempt.touch(); }}
        />
        <Inline gap={2}>
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={attempt.busy}>
            Save
          </Button>
          <Button variant="ghost" onPress={onClose} isDisabled={attempt.busy}>
            Cancel
          </Button>
        </Inline>
      </Form>
    </Dialog>
  );
}
