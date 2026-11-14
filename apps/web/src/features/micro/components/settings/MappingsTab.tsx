'use client';
// 04-UI-UX §5 "Instrument mappings" (AC-14.4). Instruments come from C7 (needs instruments.instrument.read); when that list is refused or fails, an instrument-id
// TextField replaces the Select. Per instrument: the vocabulary maps (instrument code → local code) and the default AST standard (+ version ≤ 32).
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createVocabMapAction, listInstrumentAstDefaultsAction, listInstrumentsAction, listVocabMapsAction, putInstrumentAstDefaultAction } from '../../server/actions';
import { MICRO_CODE_RE, STANDARDS, UUID_RE, type InstrumentAstDefaultDto, type InstrumentLite, type Standard, type VocabMapDto } from '../../server/types';
import { Chip, FailNotice, newKey, type Fail } from '../common';
import { useLoad } from './useLoad';

type Kind = 'organism' | 'antibiotic';
const KIND_LABEL: Record<Kind, string> = { organism: 'Organism', antibiotic: 'Antibiotic' };

export function MappingsTab({ canManage }: { canManage: boolean }) {
  const instruments = useLoad<InstrumentLite>(() => listInstrumentsAction(), 'instruments');
  const [picked, setPicked] = useState('');
  const [adding, setAdding] = useState(false);
  const instrumentId = UUID_RE.test(picked) ? picked : undefined;
  const maps = useLoad<VocabMapDto>(() => listVocabMapsAction(instrumentId!), `maps:${instrumentId}`, !!instrumentId);
  const defaults = useLoad<InstrumentAstDefaultDto>(() => listInstrumentAstDefaultsAction(), 'defaults', !!instrumentId);
  const listForbidden = instruments.loaded && !!instruments.fail; // C7 refused (403) or failed: fall back to the id field

  const columns: ColumnDef<VocabMapDto>[] = [
    { id: 'kind', header: 'Kind', isRowHeader: true, cell: (m) => KIND_LABEL[m.kind] ?? m.kind },
    { id: 'raw', header: 'Instrument code', cell: (m) => m.code_raw },
    { id: 'local', header: 'Local code', cell: (m) => m.local_code },
    { id: 'active', header: 'Active', cell: (m) => <Chip tone={m.is_active ? 'success' : 'neutral'} label={m.is_active ? 'Active' : 'Inactive'} /> },
  ];

  return (
    <section aria-labelledby="micro-mappings">
      <h2 id="micro-mappings">Instrument mappings</h2>
      {listForbidden ? (
        <TextField label="Instrument ID" name="instrument_id" maxLength={36} description="You can't list instruments here. Paste the instrument id from the instruments screen." value={picked} onChange={setPicked} />
      ) : (
        <Select<string> label="Instrument" name="instrument" placeholder="Choose an instrument" {...(picked ? { value: picked } : {})} onChange={setPicked} options={instruments.rows.map((i) => ({ value: i.id, label: `${i.code}: ${i.name}` }))} />
      )}
      {instrumentId ? (
        <>
          <FailNotice fail={maps.fail} />
          {canManage ? <div><Button onPress={() => setAdding(true)}>Add mapping</Button></div> : null}
          <DataTable<VocabMapDto> caption="Instrument code mappings" columns={columns} rows={maps.rows} getRowId={(m) => m.id} isLoading={!maps.loaded} emptyState={{ title: 'No mappings for this instrument.' }} />
          <DefaultStandard key={instrumentId} instrumentId={instrumentId} current={defaults.rows.find((d) => d.instrument_id === instrumentId)} ready={defaults.loaded} canManage={canManage} />
          {adding ? <MappingDrawer instrumentId={instrumentId} onClose={() => setAdding(false)} onSaved={maps.reload} /> : null}
        </>
      ) : null}
    </section>
  );
}

function DefaultStandard({ instrumentId, current, ready, canManage }: { instrumentId: string; current: InstrumentAstDefaultDto | undefined; ready: boolean; canManage: boolean }) {
  const toast = useToast();
  const [standard, setStandard] = useState<Standard | undefined>(current?.standard);
  const [version, setVersion] = useState(current?.standard_version ?? '');
  const [fail, setFail] = useState<Fail>();
  const [saved, setSaved] = useState<number>();
  useEffect(() => { // the defaults list arrives after the first render
    if (ready) { setStandard(current?.standard); setVersion(current?.standard_version ?? ''); setSaved(current?.version); }
  }, [ready, current?.standard, current?.standard_version, current?.version]);

  const save = async () => {
    if (!standard || version.trim() === '') { setFail({ ok: false, status: 400, code: 'common.validation_failed' }); return; }
    setFail(undefined);
    const r = await putInstrumentAstDefaultAction(instrumentId, { standard, standard_version: version }, saved);
    if (r.ok) { setSaved(r.data.version); toast.show({ tone: 'success', title: 'Default standard saved' }); } else setFail(r);
  };
  return (
    <section aria-labelledby="micro-default-std">
      <h3 id="micro-default-std">Default standard</h3>
      <FailNotice fail={fail} />
      <Form onSubmit={save}>
        <Select<Standard> label="Standard" name="standard" isDisabled={!canManage} placeholder="Not set" {...(standard ? { value: standard } : {})} onChange={setStandard} options={STANDARDS.map((s) => ({ value: s, label: s }))} />
        <TextField label="Standard version" name="standard_version" maxLength={32} isDisabled={!canManage} value={version} onChange={setVersion} />
        {canManage ? <Button type="submit">Save default</Button> : null}
      </Form>
    </section>
  );
}

function MappingDrawer({ instrumentId, onClose, onSaved }: { instrumentId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('organism');
  const [raw, setRaw] = useState('');
  const [local, setLocal] = useState('');
  const [error, setError] = useState<string>();
  const [fail, setFail] = useState<Fail>();
  const [key] = useState(newKey);

  const submit = async () => {
    if (!MICRO_CODE_RE.test(local)) { setError('Use 2 to 64 lowercase letters, digits or _.'); return; }
    setError(undefined);
    setFail(undefined);
    const r = await createVocabMapAction({ instrument_id: instrumentId, kind, code_raw: raw, local_code: local }, key);
    if (r.ok) { toast.show({ tone: 'success', title: 'Mapping saved' }); onSaved(); onClose(); } else setFail(r);
  };
  return (
    <Drawer title="Add mapping" isOpen onClose={onClose}>
      <FailNotice fail={fail} />
      <Form onSubmit={submit}>
        <Select<Kind> label="Kind" name="kind" value={kind} onChange={setKind} options={[{ value: 'organism', label: 'Organism' }, { value: 'antibiotic', label: 'Antibiotic' }]} />
        <TextField label="Instrument code (raw)" name="code_raw" isRequired maxLength={64} value={raw} onChange={setRaw} />
        <TextField label="Local code" name="local_code" isRequired maxLength={64} value={local} {...(error ? { error } : {})} onChange={setLocal} />
        <Button type="submit" variant="primary">Save</Button>
      </Form>
    </Drawer>
  );
}
