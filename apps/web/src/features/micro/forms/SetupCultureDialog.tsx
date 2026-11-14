'use client';
// 04-UI-UX §3.1.1 "Set up culture" dialog (AC-03.1 … AC-03.4). LD-140 (2026-11-13): kit components only. The server decides everything that matters (state, protocol
// precedence, planting window); the checks here only save a round trip. Body = declared fields only (S-05). Ctrl+Enter submits (kit Form). One Idempotency-Key per attempt.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { Select } from '@lims/ui/components/Select';
import { Spinner } from '@lims/ui/components/Spinner';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { FailNotice, asIso, type IsoUtc } from '../components/common';
import { useLoad } from '../components/settings/useLoad';
import { listPlatingProtocolsAction } from '../server/actions';
import { setupCultureAction } from '../server/cultureActions';
import type { CultureDetailDto, PlatingProtocolDto } from '../server/types';
import { plantedError, toOptions, whenText } from './format';
import { useAttempt } from './useAttempt';
import { useCodes } from './useCodes';

const MAX_PLATES = 12;
interface Row { id: number; media: string | undefined; text: string; error?: string | undefined }
const MEDIUM_REQUIRED = 'Choose a medium for this plate.';

export function SetupCultureDialog({ culture, onClose }: { culture: CultureDetailDto; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const attempt = useAttempt();
  const protocols = useLoad(() => listPlatingProtocolsAction(), 'setup-protocols');
  const sites = useCodes('specimen_sites');
  const media = useCodes('media');
  const ready = protocols.loaded && sites.loaded && media.loaded;

  const seq = useRef(1);
  const newRow = (m?: string, text = ''): Row => ({ id: seq.current++, media: m, text });
  const [protocolId, setProtocolId] = useState<string | undefined>(culture.suggested_protocol?.id);
  const [site, setSite] = useState<string | undefined>(culture.specimen_site_code);
  const [planted, setPlanted] = useState<IsoUtc | undefined>(() => asIso(new Date().toISOString()));
  const [plantedErr, setPlantedErr] = useState<string>();
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const applied = useRef(false);

  const active = protocols.rows.filter((p) => p.is_active !== false);
  const useProtocol = (p: PlatingProtocolDto) => {
    setProtocolId(p.id);
    if (p.default_specimen_site_code) setSite(p.default_specimen_site_code);
    const m = p.media ?? [];
    setRows(m.length > 0 ? m.slice(0, MAX_PLATES).map((x) => newRow(x.media_code, x.incubation_text ?? '')) : [newRow()]);
  };
  // Defaults once the protocols are known: the suggested protocol's media become the plate rows (AC-03.2 precedence is the server's; this is `suggested_protocol`).
  useEffect(() => {
    if (!protocols.loaded || applied.current) return;
    applied.current = true;
    const p = culture.suggested_protocol?.id ? active.find((x) => x.id === culture.suggested_protocol?.id) : undefined;
    if (p) useProtocol(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocols.loaded]);

  const setRow = (id: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    attempt.touch();
  };

  const submit = async () => {
    if (!ready) return;
    const err = plantedError(planted, Date.now());
    setPlantedErr(err);
    // Medium is checked here (not by the kit's generic "Enter …" text) so the message tells the user to choose from the list.
    if (rows.some((r) => !r.media)) setRows((rs) => rs.map((r) => (r.media ? r : { ...r, error: MEDIUM_REQUIRED })));
    if (err || !planted || rows.some((r) => !r.media)) return;
    const data = await attempt.send((key) =>
      setupCultureAction(
        culture.id,
        culture.version,
        {
          ...(protocolId ? { plating_protocol_id: protocolId } : {}),
          ...(site ? { specimen_site_code: site } : {}),
          planted_at: planted,
          plates: rows.map((r) => ({ media_code: r.media!, ...(r.text.trim() ? { incubation_text: r.text.trim() } : {}) })),
        },
        key,
      ),
    );
    if (!data) return;
    toast.show({ tone: 'success', title: `Culture set up — first read due ${whenText(data.next_read_due_at)}` });
    router.refresh();
    onClose();
  };

  return (
    <Dialog title="Set up culture" isOpen onClose={onClose} size="lg">
      <FailNotice fail={attempt.fail} />
      <Form onSubmit={submit} {...(attempt.fail?.errors ? { problem: { errors: attempt.fail.errors } } : {})}>
        {ready ? (
          <>
            <Select<string>
              label="Plating protocol"
              name="plating_protocol_id"
              placeholder="None"
              {...(protocolId ? { value: protocolId } : {})}
              options={active.filter((p) => p.id).map((p) => ({ value: p.id, label: p.display }))}
              onChange={(id) => {
                const p = active.find((x) => x.id === id);
                if (p) useProtocol(p);
                attempt.touch();
              }}
            />
            <CodedSelect label="Specimen site" name="specimen_site_code" codedSet="micro.specimen_sites" placeholder="None" {...(site ? { value: site } : {})} options={toOptions(sites.rows)} onChange={(c) => { setSite(c); attempt.touch(); }} />
            <DateTimePicker
              label="Planted at"
              name="planted_at"
              isRequired
              minuteStep={5}
              {...(planted ? { value: planted } : {})}
              {...(plantedErr ? { error: plantedErr } : {})}
              onChange={(v) => { setPlanted(v); setPlantedErr(undefined); attempt.touch(); }}
            />
            {rows.map((r) => (
              <Inline key={r.id} gap={2}>
                <CodedSelect label="Medium" name={`media_${r.id}`} codedSet="micro.media" placeholder="Medium…" {...(r.error ? { error: r.error } : {})} {...(r.media ? { value: r.media } : {})} options={toOptions(media.rows)} onChange={(c) => setRow(r.id, { media: c, error: undefined })} />
                <TextField label="Incubation" name={`incubation_${r.id}`} maxLength={120} value={r.text} onChange={(v) => setRow(r.id, { text: v })} />
                <Button variant="ghost" size="sm" isDisabled={rows.length <= 1} onPress={() => { setRows((rs) => rs.filter((x) => x.id !== r.id)); attempt.touch(); }}>
                  Remove plate
                </Button>
              </Inline>
            ))}
            <div>
              <Button size="sm" iconStart="plus" isDisabled={rows.length >= MAX_PLATES} onPress={() => { setRows((rs) => [...rs, newRow()]); attempt.touch(); }}>
                Add plate row
              </Button>
            </div>
          </>
        ) : (
          <Spinner label="Loading plating options" />
        )}
        <Inline gap={2}>
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={attempt.busy} isDisabled={!ready}>
            Set up
          </Button>
          <Button variant="ghost" onPress={onClose} isDisabled={attempt.busy}>
            Cancel
          </Button>
        </Inline>
      </Form>
    </Dialog>
  );
}
