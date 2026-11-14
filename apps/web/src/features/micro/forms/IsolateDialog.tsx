'use client';
// 04-UI-UX §3.3 add isolate / identify / edit description dialogs (AC-05.1 … AC-05.5, UI side). LD-140 (2026-11-13): kit components only.
// The isolate number is the server's (never sent). The organism comes ONLY from the coded list (Combobox, minChars 2): text that was typed but not chosen is never a code
// (AC-05.2). createIsolate has no is_reportable, so un-ticking Reportable on a new isolate is a follow-up describe call with the new isolate's version
// (describe is a full replace, so the same colony / quantity / plate are sent again). Writes: Idempotency-Key (create), If-Match "<version>" (identify, describe).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { FailNotice } from '../components/common';
import { createIsolateAction, describeIsolateAction, identifyIsolateAction, searchCodedSetAction } from '../server/cultureActions';
import type { CultureDetailDto, IsolateDto, MicroCodeDto } from '../server/types';
import { useAttempt } from './useAttempt';

export type IsolateMode = { kind: 'add' } | { kind: 'identify'; isolate: IsolateDto } | { kind: 'describe'; isolate: IsolateDto };

const loadOrganisms = async (q: string): Promise<readonly MicroCodeDto[]> => {
  const r = await searchCodedSetAction('organisms', q);
  return r.ok ? r.data.filter((o) => o.is_active) : [];
};

export function IsolateDialog({ culture, mode, onClose }: { culture: CultureDetailDto; mode: IsolateMode; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const attempt = useAttempt();
  const isolate = mode.kind === 'add' ? undefined : mode.isolate;
  const [organism, setOrganism] = useState<{ code: string; display: string } | undefined>(isolate?.organism_code ? { code: isolate.organism_code, display: isolate.organism_display ?? isolate.organism_code } : undefined);
  const [plate, setPlate] = useState<string | undefined>(isolate?.plate_id);
  const [colony, setColony] = useState(isolate?.colony_description ?? '');
  const [quantity, setQuantity] = useState(isolate?.quantity_text ?? '');
  const [reportable, setReportable] = useState(isolate?.is_reportable ?? true);
  const plates = culture.plates.filter((p) => p.status === 'active');
  const text = { colony: colony.trim(), quantity: quantity.trim() };

  const done = (title: string) => {
    toast.show({ tone: 'success', title });
    router.refresh();
    onClose();
  };

  const submit = async () => {
    if (mode.kind === 'identify') {
      if (!organism) return;
      const data = await attempt.send(() => identifyIsolateAction(mode.isolate.id, mode.isolate.version, organism.code));
      if (data) done(`Isolate ${mode.isolate.isolate_seq} identified`);
      return;
    }
    if (mode.kind === 'describe') {
      const data = await attempt.send(() =>
        describeIsolateAction(mode.isolate.id, mode.isolate.version, {
          ...(text.colony ? { colony_description: text.colony } : {}),
          ...(text.quantity ? { quantity_text: text.quantity } : {}),
          is_reportable: reportable,
          ...(plate ? { plate_id: plate } : {}),
        }),
      );
      if (data) done(`Isolate ${mode.isolate.isolate_seq} saved`);
      return;
    }
    const created = await attempt.send((key) =>
      createIsolateAction(
        culture.id,
        {
          ...(organism ? { organism_code: organism.code } : {}),
          ...(plate ? { plate_id: plate } : {}),
          ...(text.colony ? { colony_description: text.colony } : {}),
          ...(text.quantity ? { quantity_text: text.quantity } : {}),
        },
        key,
      ),
    );
    if (!created) return;
    if (reportable) return done(`Isolate ${created.isolate_seq} added`);
    // Un-ticked Reportable: follow-up describe with the new isolate's version (a failure here must not hide that the isolate exists).
    const followUp = await describeIsolateAction(created.id, created.version, {
      ...(text.colony ? { colony_description: text.colony } : {}),
      ...(text.quantity ? { quantity_text: text.quantity } : {}),
      is_reportable: false,
      ...(plate ? { plate_id: plate } : {}),
    }).catch(() => undefined);
    if (followUp?.ok) return done(`Isolate ${created.isolate_seq} added`);
    toast.show({ tone: 'warning', title: `Isolate ${created.isolate_seq} added, but it is still reportable. Edit the isolate to change that.` });
    router.refresh();
    onClose();
  };

  const title = mode.kind === 'add' ? 'Add isolate' : mode.kind === 'identify' ? `Identify isolate ${mode.isolate.isolate_seq}` : `Edit isolate ${mode.isolate.isolate_seq}`;
  const showOrganism = mode.kind !== 'describe';
  const showDetails = mode.kind !== 'identify';
  return (
    <Dialog title={title} isOpen onClose={onClose} size="md">
      <FailNotice fail={attempt.fail} />
      <Form onSubmit={submit} {...(attempt.fail?.errors ? { problem: { errors: attempt.fail.errors } } : {})}>
        {showOrganism ? (
          <Combobox<MicroCodeDto | { code: string; display: string }>
            label="Organism"
            name="organism_code"
            minChars={2}
            isRequired={mode.kind === 'identify'}
            {...(organism ? { value: organism } : {})}
            loadOptions={(q) => loadOrganisms(q)}
            getKey={(o) => o.code}
            renderValue={(o) => o.display}
            renderOption={(o) => ('organism_group_code' in o && o.organism_group_code ? `${o.display} · ${o.organism_group_code}` : o.display)}
            onChange={(o) => { setOrganism(o ? { code: o.code, display: o.display } : undefined); attempt.touch(); }}
          />
        ) : null}
        {showDetails ? (
          <>
            <Select<string>
              label="Plate"
              name="plate_id"
              placeholder="Plate (optional)"
              {...(plate ? { value: plate } : {})}
              options={plates.map((p) => ({ value: p.id, label: `Plate ${p.plate_no}` }))}
              onChange={(v) => { setPlate(v); attempt.touch(); }}
            />
            <TextArea label="Colony description" name="colony_description" maxLength={500} rows={3} value={colony} onChange={(v) => { setColony(v); attempt.touch(); }} />
            <TextField label="Quantity" name="quantity_text" maxLength={80} value={quantity} onChange={(v) => { setQuantity(v); attempt.touch(); }} />
            <Checkbox label="Reportable" isSelected={reportable} onChange={(v) => { setReportable(v); attempt.touch(); }} />
          </>
        ) : null}
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
