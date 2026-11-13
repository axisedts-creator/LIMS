'use client';
// /lab/qc (04-UI-UX §1 nav row lab.qc.capture, §3.12; 02-TRD §5.7 #43-#44; PRD AC-19.2, AC-19.3). Captured QC values only: no pass/fail, acceptance, rejection or enforcement wording and no status
// colours here — rules arrive with the QC module (C9). The list is read here (cursor paging); "Add QC result" posts #44 with one Idempotency-Key per open dialog.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { captureQcResultAction, listQcResultsAction } from '../../server/qc.actions';
import type { NamedOption, QcCaptureBody, QcResult } from '../../server/qc.types';
import { UUID_RE } from '../../server/types';
import { NativeSelect } from '../NativeSelect';
import { AlertText, errText, Field, ShortId } from '../settings/common';
import { call, newKey, utc } from '../shared';

const DEC = /^-?[0-9]+(\.[0-9]+)?$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
interface Form { centre: string; instrument: string; analyte: string; control: string; lot: string; level: string; value: string; unit: string; time: string }
type Errors = Partial<Record<keyof Form, string>>;
const EMPTY: Form = { centre: '', instrument: '', analyte: '', control: '', lot: '', level: '', value: '', unit: '', time: '' };

/** Form -> request body, or the field messages. "Result time" (datetime-local) is read as UTC and sent as an ISO UTC instant (02-CV §4.8); blank optionals are omitted. */
function build(f: Form, centres: readonly NamedOption[], instruments: readonly NamedOption[]): { body: QcCaptureBody } | { errors: Errors } {
  const errors: Errors = {};
  if (!centres.some((c) => c.id === f.centre)) errors.centre = 'Select a centre.';
  if (!instruments.some((i) => i.id === f.instrument)) errors.instrument = 'Select an instrument.';
  const analyte = f.analyte.trim(), control = f.control.trim(), value = f.value.trim(), unit = f.unit.trim();
  if (!UUID_RE.test(analyte)) errors.analyte = 'Enter the analyte ID (a UUID).';
  if (control.length < 1 || control.length > 64) errors.control = 'Enter the control ID (1 to 64 characters).';
  if (!DEC.test(value) || value.length > 40) errors.value = 'Enter the value as a decimal number, for example 5.40.';
  if (unit && !CODE.test(unit)) errors.unit = 'Unit may use letters, digits and . _ : - only.';
  const ms = f.time ? Date.parse(`${f.time}${f.time.length === 16 ? ':00' : ''}Z`) : NaN;
  if (Number.isNaN(ms)) errors.time = 'Enter the result date and time.';
  if (Object.keys(errors).length) return { errors };
  const lot = f.lot.trim(), level = f.level.trim();
  return { body: { centre_id: f.centre, instrument_id: f.instrument, analyte_id: analyte.toLowerCase(), control_id_raw: control, ...(lot ? { control_lot_raw: lot } : {}), ...(level ? { control_level: level } : {}),
    value_numeric: value, ...(unit ? { unit_code: unit } : {}), instrument_result_time: new Date(ms).toISOString() } };
}

const SOURCE: Record<string, string> = { instrument: 'Instrument', manual: 'Manual' };

export function QcResultsPage({ permissions, centres, instruments }: { permissions: readonly string[]; centres: readonly NamedOption[]; instruments: readonly NamedOption[] }) {
  const canCapture = permissions.includes('lab.qc.capture');
  const [rows, setRows] = useState<QcResult[] | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Form>(EMPTY);
  const [errs, setErrs] = useState<Errors>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const key = useRef('');

  const load = useCallback(async (cursor?: string) => {
    const r = await call(listQcResultsAction(cursor));
    if (r.ok) { setRows((x) => (cursor ? [...(x ?? []), ...r.data.data] : r.data.data)); setNext(r.data.page.next_cursor); setErr(''); } else { setRows((x) => x ?? []); setErr(errText(r)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const names = new Map(instruments.map((i) => [i.id, i.name]));
  const set = (k: keyof Form) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const close = () => { setOpen(false); setErrs({}); setMsg(''); };
  const show = () => { setF(EMPTY); setErrs({}); setMsg(''); key.current = newKey(); setOpen(true); };

  async function save() {
    if (busyRef.current) return;
    const b = build(f, centres, instruments);
    if ('errors' in b) { setErrs(b.errors); setMsg('Check the fields marked below.'); return; }
    setErrs({});
    busyRef.current = true; setBusy(true); setMsg('');
    const r = await call(captureQcResultAction(b.body, key.current));
    busyRef.current = false; setBusy(false);
    if (r.ok) { close(); setRows(null); await load(); return; }
    setMsg(errText(r));
  }

  const input = (label: string, k: keyof Form, o: { maxLength?: number; type?: string; inputMode?: 'decimal' } = {}) => (
    <Field label={label} error={errs[k]}>
      {(p) => <input {...p} type={o.type ?? 'text'} className="lims-input" value={f[k]} {...(o.maxLength ? { maxLength: o.maxLength } : {})} {...(o.inputMode ? { inputMode: o.inputMode } : {})} onChange={(e) => set(k)(e.currentTarget.value)} />}
    </Field>
  );

  return (
    <section aria-label="QC results">
      <PageHeader title="QC results (captured — rules arrive with the QC module)" helpKey="lab.qc" />
      {err ? <AlertText text={err} /> : null}
      {canCapture ? <Button variant="primary" onPress={show}>Add QC result</Button> : null}
      {rows === null ? <p role="status">Loading…</p> : rows.length === 0 ? <p>No QC results captured.</p> : (
        <>
          <table className="lims-table">
            <thead><tr>{['Time', 'Instrument', 'Analyte', 'Control', 'Lot', 'Level', 'Value', 'Unit', 'Source'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{utc(r.instrument_result_time)}</td>
                  <td>{names.get(r.instrument_id) ?? <ShortId value={r.instrument_id} />}</td>
                  <td><ShortId value={r.analyte_id} /></td>
                  <td>{r.control_id_raw}</td><td>{r.control_lot_raw ?? '—'}</td><td>{r.control_level ?? '—'}</td><td>{r.value_numeric}</td><td>{r.unit_code ?? '—'}</td>
                  <td>{SOURCE[r.source] ?? r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {next ? <Button variant="secondary" onPress={() => void load(next)}>Load more</Button> : null}
        </>
      )}

      <Dialog
        title="Add QC result"
        isOpen={open}
        onClose={close}
        footer={<><Button variant="ghost" onPress={close}>Cancel</Button><Button variant="primary" isDisabled={busy} onPress={() => void save()}>Save QC result</Button></>}
      >
        <AlertText text={msg} />
        <NativeSelect label="Centre" value={f.centre} onChange={set('centre')} error={errs.centre} options={centres.map((c) => ({ value: c.id, label: c.name }))} />
        <NativeSelect label="Instrument" value={f.instrument} onChange={set('instrument')} error={errs.instrument} options={instruments.map((i) => ({ value: i.id, label: i.name }))} />
        {input('Analyte ID', 'analyte')}
        {input('Control ID', 'control', { maxLength: 64 })}
        {input('Control lot', 'lot', { maxLength: 64 })}
        {input('Control level', 'level', { maxLength: 16 })}
        {input('Value', 'value', { inputMode: 'decimal' })}
        {input('Unit', 'unit')}
        {input('Result time (UTC)', 'time', { type: 'datetime-local' })}
      </Dialog>
    </section>
  );
}
