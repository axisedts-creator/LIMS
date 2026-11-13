'use client';
// 04-UI-UX §5 "Plating protocols" (AC-14.2). "New version" supersedes the current version and keeps the code (POST …/{id}/versions); a protocol is never edited in place.
// Read schedule: ascending whole hours 1..720, at most 10. Media rows (1..12) are re-checked by the API; the UI sends what was entered.
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { createPlatingProtocolAction, listMicroTestsAction, listPlatingProtocolsAction, versionPlatingProtocolAction } from '../../server/actions';
import { MICRO_CODE_RE, type PlatingProtocolDto, type PlatingProtocolInput, type TestLite } from '../../server/types';
import { Chip, FailNotice, newKey, yesNo, type Fail } from '../common';
import { useLoad } from './useLoad';

const CODE_HELP = 'Use 2 to 64 lowercase letters, digits or _.';
const SCHEDULE_HELP = 'Whole hours from 1 to 720, ascending, at most 10: for example 24, 48.';

/** "24, 48" → [24, 48]; undefined when it is not 1..10 strictly ascending whole hours in 1..720. */
export function parseSchedule(text: string): number[] | undefined {
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length < 1 || parts.length > 10 || parts.some((p) => !/^\d{1,3}$/.test(p))) return undefined;
  const hours = parts.map(Number);
  return hours.every((h, i) => h >= 1 && h <= 720 && (i === 0 || h > hours[i - 1]!)) ? hours : undefined;
}
const codes = (text: string) => text.split(',').map((c) => c.trim()).filter(Boolean);

export function ProtocolsTab({ canManage }: { canManage: boolean }) {
  const [editing, setEditing] = useState<PlatingProtocolDto | 'new'>();
  const { rows, loaded, fail, reload } = useLoad(() => listPlatingProtocolsAction(), 'protocols');
  const columns: ColumnDef<PlatingProtocolDto>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (p) => p.code },
    { id: 'version', header: 'Version', align: 'end', cell: (p) => String(p.version_no) },
    { id: 'display', header: 'Display', cell: (p) => p.display },
    { id: 'reads', header: 'Reads (hours)', cell: (p) => `${p.read_schedule_hours.join(', ')} h` },
    { id: 'final', header: 'Final no-growth (hours)', align: 'end', cell: (p) => String(p.final_no_growth_hours) },
    { id: 'gram', header: 'Gram stain', cell: (p) => yesNo(p.requires_gram_stain) },
    { id: 'active', header: 'Active', cell: (p) => <Chip tone={p.is_active ? 'success' : 'neutral'} label={p.is_active ? 'Active' : 'Inactive'} /> },
    ...(canManage ? [{ id: 'new', header: 'Actions', cell: (p: PlatingProtocolDto) => <Button size="sm" variant="ghost" onPress={() => setEditing(p)}>New version<VisuallyHidden> {p.code}</VisuallyHidden></Button> }] : []),
  ];
  return (
    <section aria-labelledby="micro-protocols">
      <h2 id="micro-protocols">Plating protocols</h2>
      <FailNotice fail={fail} />
      {canManage ? <div><Button onPress={() => setEditing('new')}>Add protocol</Button></div> : null}
      <DataTable<PlatingProtocolDto> caption="Plating protocols" columns={columns} rows={rows} getRowId={(p) => p.id} isLoading={!loaded} emptyState={{ title: 'No plating protocols.' }} />
      {editing ? <ProtocolDrawer key={editing === 'new' ? 'new' : editing.id} base={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={reload} /> : null}
    </section>
  );
}

function ProtocolDrawer({ base, onClose, onSaved }: { base: PlatingProtocolDto | undefined; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState(base?.code ?? '');
  const [display, setDisplay] = useState(base?.display ?? '');
  const [schedule, setSchedule] = useState(base?.read_schedule_hours.join(', ') ?? '');
  const [finalHours, setFinalHours] = useState<number | undefined>(base?.final_no_growth_hours ?? 48);
  const [gram, setGram] = useState(base?.requires_gram_stain ?? false);
  const [site, setSite] = useState(base?.default_specimen_site_code ?? '');
  const [media, setMedia] = useState((base?.media ?? []).map((m) => m.media_code).join(', '));
  const [testId, setTestId] = useState<string | undefined>(base?.applies_to?.find((a) => a.test_id)?.test_id);
  const [specimen, setSpecimen] = useState(base?.applies_to?.find((a) => a.specimen_type_code)?.specimen_type_code ?? '');
  const [tests, setTests] = useState<TestLite[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fail, setFail] = useState<Fail>();
  const [key] = useState(newKey);

  useEffect(() => {
    let alive = true;
    listMicroTestsAction().then((r) => { if (alive && r.ok) setTests(r.data); }, () => undefined);
    return () => { alive = false; };
  }, []);

  const submit = async () => {
    const hours = parseSchedule(schedule);
    const mediaCodes = codes(media);
    const e: Record<string, string> = {};
    if (!base && !MICRO_CODE_RE.test(code)) e['code'] = CODE_HELP;
    if (!hours) e['schedule'] = SCHEDULE_HELP;
    if (site && !MICRO_CODE_RE.test(site)) e['site'] = CODE_HELP;
    if (mediaCodes.some((c) => !MICRO_CODE_RE.test(c)) || mediaCodes.length > 12) e['media'] = 'Up to 12 media codes, each 2 to 64 lowercase letters, digits or _.';
    if (specimen && !MICRO_CODE_RE.test(specimen)) e['specimen'] = CODE_HELP;
    setErrors(e);
    if (Object.keys(e).length > 0 || !hours || finalHours === undefined) return;
    setFail(undefined);
    const input: PlatingProtocolInput = {
      ...(base ? {} : { code }), display, read_schedule_hours: hours, final_no_growth_hours: finalHours, requires_gram_stain: gram, ...(site ? { default_specimen_site_code: site } : {}),
      media: mediaCodes.map((m) => ({ media_code: m })),
      applies_to: [...(testId ? [{ test_id: testId }] : []), ...(specimen ? [{ specimen_type_code: specimen }] : [])],
    };
    // [CONV] the DTO always carries `version`; the fallback only keeps the If-Match well-formed for a DTO without it.
    const r = base ? await versionPlatingProtocolAction(base.id, base.version ?? 1, input, key) : await createPlatingProtocolAction(input, key);
    if (r.ok) {
      toast.show({ tone: 'success', title: base ? 'New version saved' : 'Protocol saved' });
      onSaved();
      onClose();
    } else setFail(r);
  };

  return (
    <Drawer title={base ? 'New version' : 'Add protocol'} isOpen onClose={onClose}>
      <FailNotice fail={fail} />
      <Form onSubmit={submit}>
        <TextField label="Code" name="code" isRequired maxLength={64} isReadOnly={!!base} value={code} {...(errors['code'] ? { error: errors['code'] } : {})} onChange={setCode} />
        <TextField label="Display" name="display" isRequired maxLength={120} value={display} onChange={setDisplay} />
        <TextField label="Read schedule (hours)" name="read_schedule_hours" isRequired maxLength={60} description={SCHEDULE_HELP} value={schedule} {...(errors['schedule'] ? { error: errors['schedule'] } : {})} onChange={setSchedule} />
        <IntegerField label="Final no-growth after (hours)" name="final_no_growth_hours" min={1} max={720} isRequired {...(finalHours !== undefined ? { value: finalHours } : {})} onChange={setFinalHours} />
        <Checkbox label="Gram stain required" isSelected={gram} onChange={setGram} />
        <TextField label="Default site code" name="default_specimen_site_code" maxLength={64} value={site} {...(errors['site'] ? { error: errors['site'] } : {})} onChange={setSite} />
        <TextField label="Media codes" name="media" maxLength={800} description="Comma separated, 1 to 12 codes from the Media dictionary." value={media} {...(errors['media'] ? { error: errors['media'] } : {})} onChange={setMedia} />
        <Select<string> label="Applies to test" name="test_id" {...(testId ? { value: testId } : {})} placeholder="Any test" onChange={setTestId} options={tests.map((t) => ({ value: t.id, label: `${t.code}: ${t.name}` }))} />
        <TextField label="Applies to specimen type code" name="specimen_type_code" maxLength={64} value={specimen} {...(errors['specimen'] ? { error: errors['specimen'] } : {})} onChange={setSpecimen} />
        <Button type="submit" variant="primary">Save</Button>
      </Form>
    </Drawer>
  );
}
