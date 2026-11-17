'use client';
// T0D-TESTMGMT-1 done_when (5) (LD-318): reference range manager on /catalog/tests/<id>?tab=ranges&analyte=<id> (existing route).
// One grid with the 16 ElabAssist columns (headers drawn even with no band), an inline row editor (click or Enter on a row, Add range),
// every server validation message shown in that editor, a Draft / Published badge, and Publish ONLY for catalog.reference_range.publish
// on a draft (LD-318 decision 2: the pathologist sign-off stays the gate). Critical Low / High are written to the critical limit set
// (separate PUT), never into the reference band. Range Name is a derived label (RangeBand has no name: API GAP, see notes).
import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { useToast } from '@lims/ui/components/Toast';
import { createRangeSetDraftAction, publishRangeSetAction, replaceBandsAction } from '../server/actions';
import type { Band, RangeSet } from '../server/types';
import { newKey, PERM, STATUS_LABEL, STATUS_TONE } from './shared';
import { Check, ErrorList, failText, ReadOnlyNote, SelectIn, TextIn, type ServerError } from './tm-ui';
import './catalog.css';

type Age = { value: number; unit: string };
type RBand = Band & { instrument_id?: string; laboratory_id?: string; default_range?: boolean; method_id?: string; auto_approved_low?: string; auto_approved_high?: string };
type Opt = { value: string; label: string };
const COLS = ['Range Name', 'Age From', 'Age To', 'Age Unit', 'Sex', 'Laboratory', 'Instrument', 'Default', 'Normal Low', 'Normal High', 'Critical Low', 'Critical High', 'Auto Approved Low', 'Auto Approved High', 'Display Text', 'Method'];
const UNITS = ['hour', 'day', 'week', 'month', 'year'];
const SEXES: [string, string][] = [['any', 'Any'], ['male', 'Male'], ['female', 'Female'], ['third_gender', 'Third gender']];
const BAND_KEYS = ['sex', 'kind', 'sort_order', 'age_low', 'age_high', 'specimen_type_id', 'low', 'high', 'normal_codes', 'display_text', 'instrument_id', 'laboratory_id', 'default_range', 'method_id', 'auto_approved_low', 'auto_approved_high'] as const;
const CRIT_KEYS = ['sex', 'age_low', 'age_high', 'specimen_type_id', 'low', 'high', 'abnormal_codes'] as const;
const DEC = /^-?\d{1,12}(\.\d{1,6})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sexLabel = (s?: string) => SEXES.find(([v]) => v === s)?.[1] ?? 'Any';
const only = <K extends string>(o: Record<string, unknown>, keys: readonly K[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== '').map((k) => [k, o[k]]));
const sameAge = (a?: Age, b?: Age) => (a?.value ?? null) === (b?.value ?? null) && (a?.unit ?? null) === (b?.unit ?? null);
/** Critical band for a reference band: same sex and same ages, else same sex with no age bounds (covers every age). */
const critOf = (crit: readonly Band[], b: RBand) => {
  const sex = (c: Band) => (c.sex ?? 'any') === (b.sex ?? 'any');
  const exact = crit.findIndex((c) => sex(c) && sameAge(c.age_low, b.age_low) && sameAge(c.age_high, b.age_high));
  return exact >= 0 ? exact : crit.findIndex((c) => sex(c) && !c.age_low && !c.age_high);
};
const rangeName = (b: RBand) => `${sexLabel(b.sex)} ${b.age_low?.value ?? 0}${b.age_high ? `-${b.age_high.value}` : '+'} ${b.age_low?.unit ?? b.age_high?.unit ?? 'year'}`;

type Draft = Record<string, string> & { default_range: string };
const toDraft = (b: RBand | undefined, c: Band | undefined): Draft => ({
  sex: b?.sex ?? 'any', age_from: b?.age_low ? String(b.age_low.value) : '', age_to: b?.age_high ? String(b.age_high.value) : '', age_unit: b?.age_low?.unit ?? b?.age_high?.unit ?? 'year',
  laboratory_id: b?.laboratory_id ?? '', instrument_id: b?.instrument_id ?? '', default_range: b?.default_range ? 'true' : '', low: b?.low ?? '', high: b?.high ?? '',
  critical_low: c?.low ?? '', critical_high: c?.high ?? '', auto_approved_low: b?.auto_approved_low ?? '', auto_approved_high: b?.auto_approved_high ?? '', display_text: b?.display_text ?? '', method_id: b?.method_id ?? '',
});

export function RangeManager({ analyte, sets, criticalSets, methods, permissions }: {
  analyte: { id: string; code: string; name?: string };
  sets: readonly RangeSet[];
  criticalSets: readonly RangeSet[];
  methods: readonly Opt[];
  permissions: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const manage = permissions.includes(PERM.manage);
  const publisher = permissions.includes(PERM.publish);
  const set = sets.find((s) => s.status === 'draft') ?? sets.find((s) => s.status === 'published') ?? sets[0];
  const crit = criticalSets.find((s) => s.status === 'draft') ?? criticalSets.find((s) => s.status === 'published');
  const [bands, setBands] = useState<RBand[]>(() => [...((set?.bands ?? []) as RBand[])]);
  const critBands = (crit?.bands ?? []) as Band[];
  const editable = manage && set?.status === 'draft';
  const [edit, setEdit] = useState<{ i: number; d: Draft }>();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const methodName = (id?: string) => methods.find((m) => m.value === id)?.label ?? '';

  const open = (i: number) => { if (!editable) return; setErrors([]); setEdit({ i, d: toDraft(bands[i], critBands[critOf(critBands, bands[i] ?? {})]) }); };
  const add = () => { setErrors([]); setEdit({ i: bands.length, d: toDraft(undefined, undefined) }); };
  const upd = (k: string) => (v: string) => setEdit((e) => (e ? { ...e, d: { ...e.d, [k]: v } } : e));

  const bandFrom = (d: Draft, base: RBand | undefined, i: number): { band?: RBand; problems: string[] } => {
    const problems: string[] = [];
    const age = (v: string, label: string): Age | undefined => {
      if (!v.trim()) return undefined;
      if (!/^\d{1,3}$/.test(v.trim()) || Number(v) > 200) { problems.push(`${label}: a whole number from 0 to 200.`); return undefined; }
      return { value: Number(v), unit: d.age_unit };
    };
    for (const [k, l] of [['low', 'Normal Low'], ['high', 'Normal High'], ['critical_low', 'Critical Low'], ['critical_high', 'Critical High'], ['auto_approved_low', 'Auto Approved Low'], ['auto_approved_high', 'Auto Approved High']] as const) {
      if (d[k] && !DEC.test(d[k]!.trim())) problems.push(`${l}: a decimal number such as 13.0.`);
    }
    for (const [k, l] of [['laboratory_id', 'Laboratory'], ['instrument_id', 'Instrument']] as const) if (d[k] && !UUID.test(d[k]!.trim())) problems.push(`${l}: paste the id from its record.`);
    const band: RBand = {
      ...(only(base ?? {}, BAND_KEYS) as RBand), sex: d.sex!, kind: base?.kind ?? 'numeric', sort_order: base?.sort_order ?? i,
      ...(d.display_text ? { display_text: d.display_text } : {}),
    };
    for (const k of ['age_low', 'age_high', 'low', 'high', 'display_text', 'instrument_id', 'laboratory_id', 'method_id', 'auto_approved_low', 'auto_approved_high', 'default_range'] as const) delete band[k];
    const lo = age(d.age_from!, 'Age From'), hi = age(d.age_to!, 'Age To');
    Object.assign(band, lo ? { age_low: lo } : {}, hi ? { age_high: hi } : {}, d.low ? { low: d.low.trim() } : {}, d.high ? { high: d.high.trim() } : {},
      d.display_text ? { display_text: d.display_text } : {}, d.instrument_id ? { instrument_id: d.instrument_id.trim().toLowerCase() } : {}, d.laboratory_id ? { laboratory_id: d.laboratory_id.trim().toLowerCase() } : {},
      d.method_id ? { method_id: d.method_id } : {}, d.auto_approved_low ? { auto_approved_low: d.auto_approved_low.trim() } : {}, d.auto_approved_high ? { auto_approved_high: d.auto_approved_high.trim() } : {},
      d.default_range ? { default_range: true } : {});
    return problems.length ? { problems } : { band, problems };
  };

  const save = async () => {
    if (!edit || !set || busy) return;
    const { band, problems } = bandFrom(edit.d, bands[edit.i], edit.i);
    if (!band) return setErrors(problems);
    setBusy(true); setErrors([]);
    try {
      const next = [...bands];
      next[edit.i] = band;
      const r = await replaceBandsAction('ranges', set.id, set.version, next.map((b, i) => ({ ...(only(b, BAND_KEYS) as RBand), sort_order: i })) as Band[]);
      if (!r.ok) return setErrors(listed(r.errors as ServerError[] | undefined, r.code));
      setBands(next);
      // Critical Low / High live in the critical limit set (a draft is started from the published one when needed).
      const before = toDraft(bands[edit.i], critBands[critOf(critBands, bands[edit.i] ?? {})]);
      if (edit.d.critical_low !== before.critical_low || edit.d.critical_high !== before.critical_high) {
        let cs = criticalSets.find((s) => s.status === 'draft');
        if (!cs) {
          const c = await createRangeSetDraftAction('critical', analyte.id, crit ? { copy_from_set_id: crit.id } : { bands: [] }, newKey());
          if (!c.ok) return setErrors([`Ranges saved; critical limits not saved: ${failText(c.code)}`]);
          cs = c.data;
        }
        const cb = [...((cs.bands ?? []) as Band[])].map((b) => only(b as Record<string, unknown>, CRIT_KEYS) as Band);
        const j = critOf(cb, bands[edit.i] ?? band);
        const where = j >= 0 ? { ...cb[j] } : { sex: band.sex, age_low: band.age_low, age_high: band.age_high }; // an existing band keeps its own sex / ages
        const nb = only({ ...where, low: edit.d.critical_low?.trim(), high: edit.d.critical_high?.trim() }, CRIT_KEYS) as Band;
        if (!nb.low && !nb.high) { if (j >= 0) cb.splice(j, 1); } else if (j >= 0) cb[j] = nb; else cb.push(nb);
        const c = await replaceBandsAction('critical', cs.id, cs.version, cb);
        if (!c.ok) return setErrors([`Ranges saved; critical limits not saved:`, ...listed(c.errors as ServerError[] | undefined, c.code)]);
      }
      setEdit(undefined);
      toast.show({ tone: 'success', title: 'Range saved to the draft.' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  const newDraft = async () => {
    const r = await createRangeSetDraftAction('ranges', analyte.id, set ? { copy_from_set_id: set.id } : { bands: [] }, newKey());
    if (!r.ok) return setErrors([failText(r.code)]);
    toast.show({ tone: 'success', title: 'Draft started.' });
    router.refresh();
  };

  const status = set?.status;
  const d = edit?.d;
  const editor = d ? (
    <tr role="row" className="tm-editor">
      <td role="gridcell" colSpan={COLS.length}>
        <div role="group" aria-label="Edit range" className="lims-form tm-editor-grid" data-label-placement="start">
          <SelectIn label="Sex" value={d['sex']!} onChange={upd('sex')} options={SEXES.map(([value, label]) => ({ value, label }))} />
          <TextIn label="Age From" type="number" min={0} max={200} value={d['age_from']!} onChange={upd('age_from')} />
          <TextIn label="Age To" type="number" min={0} max={200} value={d['age_to']!} onChange={upd('age_to')} />
          <SelectIn label="Age Unit" value={d['age_unit']!} onChange={upd('age_unit')} options={UNITS.map((u) => ({ value: u, label: u }))} />
          <TextIn label="Laboratory" value={d['laboratory_id']!} onChange={upd('laboratory_id')} maxLength={36} hint="Laboratory id; empty = every laboratory." />
          <TextIn label="Instrument" value={d['instrument_id']!} onChange={upd('instrument_id')} maxLength={36} hint="Instrument id; empty = any instrument." />
          <Check label="Default" checked={!!d.default_range} onChange={(v) => upd('default_range')(v ? 'true' : '')} />
          <TextIn label="Normal Low" value={d['low']!} onChange={upd('low')} maxLength={20} />
          <TextIn label="Normal High" value={d['high']!} onChange={upd('high')} maxLength={20} />
          <TextIn label="Critical Low" value={d['critical_low']!} onChange={upd('critical_low')} maxLength={20} />
          <TextIn label="Critical High" value={d['critical_high']!} onChange={upd('critical_high')} maxLength={20} />
          <TextIn label="Auto Approved Low" value={d['auto_approved_low']!} onChange={upd('auto_approved_low')} maxLength={20} />
          <TextIn label="Auto Approved High" value={d['auto_approved_high']!} onChange={upd('auto_approved_high')} maxLength={20} />
          <TextIn label="Display Text" value={d['display_text']!} onChange={upd('display_text')} maxLength={500} />
          <SelectIn label="Method" value={d['method_id']!} onChange={upd('method_id')} options={methods} blank="None" />
        </div>
        <ErrorList errors={errors} />
        <div className="lims-inline catalog-gap-2">
          <Button size="sm" variant="primary" isDisabled={busy} onPress={() => void save()}>Save range</Button>
          <Button size="sm" variant="ghost" onPress={() => { setEdit(undefined); setErrors([]); }}>Cancel</Button>
        </div>
      </td>
    </tr>
  ) : null;

  return (
    <div className="lims-stack catalog-gap-2">
      <div className="lims-inline catalog-gap-2">
        <h2 className="lims-section-title">Reference ranges {analyte.code}</h2>
        {set ? <><span>Version {set.version_no}</span> <Badge tone={STATUS_TONE[set.status] ?? 'neutral'}>{STATUS_LABEL[set.status] ?? set.status}</Badge></> : null}
        {editable ? <Button size="sm" onPress={add} isDisabled={!!edit}>Add range</Button> : null}
        {manage && status !== 'draft' ? <Button size="sm" onPress={() => void newDraft()}>{set ? 'Edit as new draft' : 'New draft'}</Button> : null}
        {publisher && status === 'draft' ? <Button size="sm" variant="primary" onPress={() => setPublishing(true)}>Publish</Button> : null}
      </div>
      {manage ? null : <ReadOnlyNote />}
      {status === 'draft' && !publisher ? <p className="lims-description">A pathologist with the publish permission makes this draft live.</p> : null}
      {!edit ? <ErrorList errors={errors} /> : null}
      <div className="tm-scroll-x">
        <table role="grid" aria-label={`Reference ranges of ${analyte.code}`} className="lims-table lims-table-compact">
          <thead><tr role="row">{COLS.map((c) => <th key={c} role="columnheader" scope="col">{c}</th>)}</tr></thead>
          <tbody>
            {bands.length === 0 && !edit ? <tr role="row"><td role="gridcell" colSpan={COLS.length} className="lims-description">No ranges yet.{editable ? ' Use Add range.' : ''}</td></tr> : null}
            {bands.map((b, i) => {
              const c = critBands[critOf(critBands, b)];
              const cells = [rangeName(b), b.age_low ? String(b.age_low.value) : '', b.age_high ? String(b.age_high.value) : '', b.age_low?.unit ?? b.age_high?.unit ?? '', sexLabel(b.sex), b.laboratory_id ?? '', b.instrument_id ?? '',
                b.default_range ? 'Yes' : '', b.low ?? '', b.high ?? '', c?.low ?? '', c?.high ?? '', b.auto_approved_low ?? '', b.auto_approved_high ?? '', b.display_text ?? '', methodName(b.method_id)];
              return (
                <Fragment key={i}>
                  <tr role="row" tabIndex={editable ? 0 : -1} aria-selected={edit?.i === i} className="lims-row tm-row" onClick={() => open(i)} onKeyDown={(e) => { if (e.key === 'Enter') open(i); }}>
                    {cells.map((v, j) => <td key={j} role="gridcell">{v}</td>)}
                  </tr>
                  {edit?.i === i ? editor : null}
                </Fragment>
              );
            })}
            {edit && edit.i >= bands.length ? editor : null}
          </tbody>
        </table>
      </div>
      {publishing && set ? <PublishDialog set={set} onClose={() => setPublishing(false)} onDone={() => { setPublishing(false); toast.show({ tone: 'success', title: `Reference ranges v${set.version_no} published.` }); router.refresh(); }} /> : null}
    </div>
  );
}

/** Server errors[] listed in full, each with its band number when the pointer names one. */
function listed(errors: readonly ServerError[] | undefined, code: string): string[] {
  if (!errors?.length) return [failText(code)];
  return errors.map((e) => e.message);
}

function PublishDialog({ set, onClose, onDone }: { set: RangeSet; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [key] = useState(newKey); // one key across retries (step-up)
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    if (!reason.trim()) return setError('Enter the change reason.');
    setBusy(true);
    try {
      const r = await publishRangeSetAction('ranges', set.id, set.version, { change_reason: reason.trim() }, key);
      if (r.ok) onDone(); else setError((r.errors as ServerError[] | undefined)?.map((e) => e.message).join(' ') || failText(r.code));
    } finally { setBusy(false); }
  };
  return (
    <Dialog title={`Publish reference ranges v${set.version_no}`} isOpen size="md" onClose={onClose}
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isDisabled={busy} onPress={() => void go()}>Publish</Button></>}>
      <TextIn label="Change reason" value={reason} onChange={setReason} area maxLength={500} required error={error} />
      <p className="lims-description">Results use the published ranges from now on. Earlier reports keep the ranges they were released with.</p>
    </Dialog>
  );
}
