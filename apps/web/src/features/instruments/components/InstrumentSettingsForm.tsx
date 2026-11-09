'use client';
// SCR-11 Instrument settings (04-UI-UX §3 SCR-11, 02-TRD §7.4, E40/E41). One form; save = PUT with If-Match "<version>".
// No raw-archive retention field: that is a C2 tenant setting (D-42), only explained in the help text.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { fieldErrorsByPointer } from '../forms/errors';
import { SETTINGS_RANGES, settingsBody, validateSettings, type SettingsNumKey } from '../forms/settings';
import help from '../help/instruments.settings';
import { updateInstrumentSettingsAction } from '../server/actions';
import type { InstrumentSettings, InstrumentSettingsBody } from '../server/types';
import { hasPerm } from './labels';

const MANAGE = 'instruments.instrument.manage';
const CONFLICT = 'Someone else changed these settings. Reload to see them.';
const WINDOW_SAVED = 'Saved. Agents pick up the new update window within a minute.';
const RETENTION_HELP = help.sections.find((s) => s.heading === 'Raw message retention')?.body;
const NUM_LABELS: Record<SettingsNumKey, string> = {
  default_backlog_threshold: 'Default backlog threshold',
  backlog_max_oldest_pending_seconds: 'Backlog oldest pending seconds',
  clock_offset_warn_seconds: 'Clock warning seconds',
  agent_uploaded_retention_hours: 'Agent local retention hours',
};
const NUM_KEYS = Object.keys(NUM_LABELS) as SettingsNumKey[];
const FIELD_PTRS = new Set([...NUM_KEYS, 'update_window_from', 'update_window_to'].map((k) => `/${k}`));

type Nums = Record<SettingsNumKey, number | undefined>;

export function InstrumentSettingsForm({ settings, permissions = [] }: { settings: InstrumentSettings; permissions?: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const ro = !hasPerm(permissions, MANAGE);
  const [nums, setNums] = useState<Nums>(() => Object.fromEntries(NUM_KEYS.map((k) => [k, settings[k]])) as Nums);
  const [from, setFrom] = useState(settings.update_window_from ?? '');
  const [to, setTo] = useState(settings.update_window_to ?? '');
  const [show, setShow] = useState(false); // client errors appear after the first Save press
  const [serverErr, setServerErr] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const version = useRef(settings.version);
  if (settings.version > version.current) version.current = settings.version;
  const savedWindow = useRef(`${settings.update_window_from ?? ''}|${settings.update_window_to ?? ''}`);

  const build = (): Record<string, unknown> => ({ ...nums, ...(from ? { update_window_from: from } : {}), ...(to ? { update_window_to: to } : {}) });
  const clientErr = fieldErrorsByPointer(validateSettings(build()));
  const clear = (ptr: string) => setServerErr(({ [ptr]: _, ...r }) => r);
  const err = (ptr: string) => {
    const e = serverErr[ptr] ?? (show ? clientErr[ptr] : undefined);
    return e ? { error: e } : {};
  };
  const readOnly = ro ? { isReadOnly: true as const } : {};

  const submit = async () => {
    if (ro || inFlight.current) return;
    setShow(true);
    setAlert(undefined);
    const body = build();
    if (validateSettings(body).length) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await updateInstrumentSettingsAction(version.current, settingsBody(body) as unknown as InstrumentSettingsBody);
      if (r.ok) {
        const win = `${from}|${to}`;
        const windowChanged = win !== savedWindow.current;
        savedWindow.current = win;
        version.current = r.data.version;
        setServerErr({});
        toast.show({ tone: 'success', title: windowChanged ? WINDOW_SAVED : 'Saved.' }); // [CONV] text for a save without window change
        router.refresh();
        return;
      }
      if (r.code === 'common.version_conflict') { setAlert(CONFLICT); return; } // entries stay; the user reloads, nothing is retried
      const mapped = fieldErrorsByPointer(r.errors);
      const known = Object.fromEntries(Object.entries(mapped).filter(([p]) => FIELD_PTRS.has(p)));
      setServerErr(known);
      if (!Object.keys(known).length) setAlert(`Could not save the settings (${r.code})`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const num = (k: SettingsNumKey) => {
    const [min, max] = SETTINGS_RANGES[k];
    const ptr = `/${k}`;
    return <IntegerField label={NUM_LABELS[k]} name={k} min={min} max={max} {...(nums[k] !== undefined ? { value: nums[k]! } : {})} onChange={(v) => { setNums((n) => ({ ...n, [k]: v })); clear(ptr); }} {...readOnly} {...err(ptr)} />;
  };
  const time = (label: string, k: 'update_window_from' | 'update_window_to', value: string, set: (v: string) => void) => (
    <TextField label={label} name={k} maxLength={5} value={value} description="HH:MM, optional. Set both or neither." onChange={(v) => { set(v); clear(`/${k}`); }} {...readOnly} {...err(`/${k}`)} />
  );

  return (
    <section aria-label="Instrument settings">
      <Form onSubmit={submit}>
        {alert ? (
          <div role="alert">
            <Banner tone={alert === CONFLICT ? 'warning' : 'danger'} title={alert} />
          </div>
        ) : null}
        <Card title="Backlog and clock">
          {num('default_backlog_threshold')}
          {num('backlog_max_oldest_pending_seconds')}
          {num('clock_offset_warn_seconds')}
        </Card>
        <Card title="Agent PC">
          {num('agent_uploaded_retention_hours')}
          {time('Update window from', 'update_window_from', from, setFrom)}
          {time('Update window to', 'update_window_to', to, setTo)}
        </Card>
        <p className="lims-description">{RETENTION_HELP}</p>
        {ro ? null : <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy}>Save</Button>}
      </Form>
    </section>
  );
}
