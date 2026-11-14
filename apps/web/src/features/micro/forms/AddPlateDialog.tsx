'use client';
// 04-UI-UX §3.1.2 "Add plate" dialog (AC-03.* UI side). LD-140 (2026-11-13): kit components only. Parent plate = an active plate, From isolate = a subculture source.
// planted_at is only sent when the user changed it (the server defaults it to now); the server decides whether the culture still accepts plates.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { FailNotice, asIso, type IsoUtc } from '../components/common';
import { addPlateAction } from '../server/cultureActions';
import type { CultureDetailDto } from '../server/types';
import { toOptions } from './format';
import { useAttempt } from './useAttempt';
import { useCodes } from './useCodes';

export function AddPlateDialog({ culture, onClose }: { culture: CultureDetailDto; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const attempt = useAttempt();
  const media = useCodes('media');
  const [medium, setMedium] = useState<string>();
  const [mediumErr, setMediumErr] = useState<string>();
  const [text, setText] = useState('');
  const [parent, setParent] = useState<string>();
  const [source, setSource] = useState<string>();
  const [planted, setPlanted] = useState<IsoUtc | undefined>(() => asIso(new Date().toISOString()));
  const [edited, setEdited] = useState(false);
  const [plantedErr, setPlantedErr] = useState<string>();

  const submit = async () => {
    setMediumErr(medium ? undefined : 'Choose a medium for this plate.');
    if (!medium) return;
    if (planted && Date.parse(planted) > Date.now()) {
      setPlantedErr('Planted at cannot be in the future.');
      return;
    }
    const data = await attempt.send((key) =>
      addPlateAction(
        culture.id,
        {
          media_code: medium,
          ...(text.trim() ? { incubation_text: text.trim() } : {}),
          ...(parent ? { parent_plate_id: parent } : {}),
          ...(source ? { source_isolate_id: source } : {}),
          ...(edited && planted ? { planted_at: planted } : {}),
        },
        key,
      ),
    );
    if (!data) return;
    toast.show({ tone: 'success', title: `Plate ${data.plate_no} added` });
    router.refresh();
    onClose();
  };

  const plates = culture.plates.filter((p) => p.status === 'active');
  return (
    <Dialog title="Add plate" isOpen onClose={onClose} size="md">
      <FailNotice fail={attempt.fail} />
      <Form onSubmit={submit} {...(attempt.fail?.errors ? { problem: { errors: attempt.fail.errors } } : {})}>
        <CodedSelect label="Medium" name="media_code" codedSet="micro.media" placeholder="Medium…" {...(mediumErr ? { error: mediumErr } : {})} {...(medium ? { value: medium } : {})} options={toOptions(media.rows)} onChange={(c) => { setMedium(c); setMediumErr(undefined); attempt.touch(); }} />
        <TextField label="Incubation" name="incubation_text" maxLength={120} value={text} onChange={(v) => { setText(v); attempt.touch(); }} />
        <Select<string>
          label="Parent plate"
          name="parent_plate_id"
          placeholder="Parent plate (optional)"
          {...(parent ? { value: parent } : {})}
          options={plates.map((p) => ({ value: p.id, label: `Plate ${p.plate_no}` }))}
          onChange={(v) => { setParent(v); attempt.touch(); }}
        />
        <Select<string>
          label="From isolate"
          name="source_isolate_id"
          placeholder="From isolate (optional)"
          {...(source ? { value: source } : {})}
          options={culture.isolates.map((i) => ({ value: i.id, label: `Isolate ${i.isolate_seq}` }))}
          onChange={(v) => { setSource(v); attempt.touch(); }}
        />
        <DateTimePicker
          label="Planted at"
          name="planted_at"
          {...(planted ? { value: planted } : {})}
          {...(plantedErr ? { error: plantedErr } : {})}
          onChange={(v) => { setPlanted(v); setEdited(true); setPlantedErr(undefined); attempt.touch(); }}
        />
        <Inline gap={2}>
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={attempt.busy}>
            Add plate
          </Button>
          <Button variant="ghost" onPress={onClose} isDisabled={attempt.busy}>
            Cancel
          </Button>
        </Inline>
      </Form>
    </Dialog>
  );
}
