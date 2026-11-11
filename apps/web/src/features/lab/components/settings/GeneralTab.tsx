'use client';
// General tab (04-UI-UX §3.13; 02-TRD §9.1): GET /v1/lab/settings -> labelled controls; Save = PUT with If-Match "<version>" and the ten LabSettingsUpdate keys only.
// The §9.1 ranges are validated here too (the API re-checks: CHECK ranges never reach the database as a 500). Without lab.config.manage the values are read-only.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { useToast } from '@lims/ui/components/Toast';
import { getLabSettingsAction, updateLabSettingsAction } from '../../server/config.actions';
import type { LabSettings } from '../../server/config.types';
import { call } from '../shared';
import { AlertText, CheckInput, errText, Field, isStale, TextInput } from './common';

type IntKey = 'label_width_mm' | 'label_height_mm' | 'label_copies_default' | 'history_days';
type BoolKey = 'host_query_requires_received' | 'ingest_auto_receive' | 'critical_notification_blocks_approval' | 'recollection_default' | 'delta_check_enabled';
type Form = Record<IntKey, string> & Record<BoolKey, boolean>;

const INTS: readonly { key: IntKey; label: string; min: number; max: number }[] = [
  { key: 'label_width_mm', label: 'Label width (mm)', min: 20, max: 100 },
  { key: 'label_height_mm', label: 'Label height (mm)', min: 10, max: 60 },
  { key: 'label_copies_default', label: 'Copies per specimen', min: 1, max: 5 },
  { key: 'history_days', label: 'History (days)', min: 30, max: 3650 },
];
const BOOLS: readonly { key: BoolKey; label: string }[] = [
  { key: 'host_query_requires_received', label: 'Host query requires received specimen' },
  { key: 'ingest_auto_receive', label: 'Auto-receive instrument results' },
  { key: 'critical_notification_blocks_approval', label: 'Critical notification blocks approval' },
  { key: 'recollection_default', label: 'Pre-tick recollection on reject' },
  { key: 'delta_check_enabled', label: 'Delta check enabled' },
];
const toForm = (s: LabSettings): Form => ({
  label_width_mm: String(s.label_width_mm), label_height_mm: String(s.label_height_mm), label_copies_default: String(s.label_copies_default), history_days: String(s.history_days),
  host_query_requires_received: s.host_query_requires_received, ingest_auto_receive: s.ingest_auto_receive,
  critical_notification_blocks_approval: s.critical_notification_blocks_approval, recollection_default: s.recollection_default, delta_check_enabled: s.delta_check_enabled,
});

export function GeneralTab({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<{ version: number; form: Form } | null>(null);
  const [readErr, setReadErr] = useState('');
  const [f, setF] = useState<Form | null>(null);
  const [errs, setErrs] = useState<Partial<Record<IntKey, string>>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    const r = await call(getLabSettingsAction());
    if (!r.ok) return setReadErr(errText(r));   // a failed reload keeps the form the user is looking at
    setReadErr(''); setLoaded({ version: r.data.version, form: toForm(r.data) }); setF(toForm(r.data)); setErrs({});
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (readErr && !loaded) return <AlertText text={readErr} />;
  if (!loaded || !f) return <p role="status">Loading…</p>;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  async function save() {
    if (busyRef.current || !f || !loaded) return;
    const e: Partial<Record<IntKey, string>> = {};
    for (const i of INTS) if (!/^[0-9]{1,5}$/.test(f[i.key].trim()) || Number(f[i.key]) < i.min || Number(f[i.key]) > i.max) e[i.key] = `Enter a whole number between ${i.min} and ${i.max}.`;
    setErrs(e);
    if (Object.keys(e).length) return;
    busyRef.current = true; setBusy(true); setErr('');
    const r = await call(updateLabSettingsAction(loaded.version, {
      label_width_mm: Number(f.label_width_mm), label_height_mm: Number(f.label_height_mm), label_copies_default: Number(f.label_copies_default), label_renderer: 'html_svg',
      host_query_requires_received: f.host_query_requires_received, ingest_auto_receive: f.ingest_auto_receive, critical_notification_blocks_approval: f.critical_notification_blocks_approval,
      recollection_default: f.recollection_default, delta_check_enabled: f.delta_check_enabled, history_days: Number(f.history_days),
    }));
    busyRef.current = false; setBusy(false);
    if (r.ok) { setLoaded({ version: r.data.version, form: toForm(r.data) }); setF(toForm(r.data)); return toast.show({ tone: 'success', title: 'Settings saved' }); }
    setErr(errText(r));
    if (isStale(r)) await load();   // the user sees the newer values; the next Save uses the new version
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
      <AlertText text={err} />
      {INTS.map((i) => <TextInput key={i.key} label={i.label} type="number" value={f[i.key]} onChange={(v) => set(i.key, v)} error={errs[i.key]} disabled={!canManage} />)}
      <Field label="Label renderer">{(p) => <select {...p} className="lims-input" value="html_svg" disabled={!canManage} onChange={() => undefined}><option value="html_svg">html_svg</option></select>}</Field>
      {BOOLS.map((b) => <CheckInput key={b.key} label={b.label} checked={f[b.key]} onChange={(v) => set(b.key, v)} disabled={!canManage} />)}
      {canManage ? <Button variant="primary" type="submit" isDisabled={busy}>Save settings</Button> : null}
    </form>
  );
}
