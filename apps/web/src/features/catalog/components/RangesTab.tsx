'use client';
// SCR-08 Reference ranges / Critical limits tab (04-UI-UX §4, F-04): version strip, band grid (EditableGrid, APG data grid), publish.
// Decimals stay strings (13.0 ≠ 13). Published sets are read-only; a new version is a copy (F-04). Publish is privileged (typed confirmation).
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { EditableGrid, type EditableGridColumn, type EditableGridRow } from '@lims/ui/components/EditableGrid';
import { Form } from '@lims/ui/components/Form';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createRangeSetDraftAction, discardRangeSetAction, publishRangeSetAction, replaceBandsAction, retireRangeSetAction } from '../server/actions';
import { AGE_UNITS, type Age, type Band, type FieldError, type RangeKind, type RangeSet } from '../server/types';
import { FailBanner, GatedButton, newKey, PERM, STATUS_LABEL, STATUS_TONE, type Fail } from './shared';

const AGE_RULE = 'Lower age is included, upper age is not. Example: 0–18 years covers patients until the day before their 18th birthday.';
const EMPTY: Record<RangeKind, string> = {
  ranges: 'No reference ranges. Results for this analyte will show no range and C5 will ask for manual review.',
  critical: 'No critical limits. Results for this analyte will never be flagged critical.',
};
const SEX_VALUES = ['any', 'male', 'female'];
const KINDS = ['numeric', 'text', 'ordinal'];
const DEC = /^-?\d+(\.\d+)?$/;
const CODE = /^[A-Z0-9_+-]{1,16}$/;

const ageText = (a?: Age) => (a ? `${a.value} ${a.unit}${a.value === 1 ? '' : 's'}` : '');
function parseAge(t: string): Age | undefined | 'bad' {
  const s = t.trim();
  if (!s) return undefined;
  const m = /^(\d{1,3})\s*(day|week|month|year)s?$/i.exec(s);
  return m ? { value: Number(m[1]), unit: m[2]!.toLowerCase() } : 'bad';
}
const ageDays = (a?: Age) => (a ? a.value * (AGE_UNITS[a.unit] ?? 0) : undefined);

type ColId = 'sex' | 'agefrom' | 'ageto' | 'specimen' | 'kind' | 'low' | 'high' | 'codes' | 'text';
const FIELD_COL: Record<string, ColId> = { sex: 'sex', age_low: 'agefrom', age_high: 'ageto', specimen_type_id: 'specimen', kind: 'kind', low: 'low', high: 'high', normal_codes: 'codes', abnormal_codes: 'codes', display_text: 'text' };

export function RangesTab({ analyte, kind, sets, valueSet, specimenTypes, permissions }: {
  analyte: { id: string; code: string; unit_code?: string };
  kind: RangeKind;
  sets: readonly RangeSet[];
  valueSet?: { code: string; display: string; is_ordered: boolean } | undefined;
  specimenTypes: readonly { id: string; code: string; name: string }[];
  permissions: readonly string[];
}) {
  void valueSet; // reserved: ordinal normal-code suggestions
  const router = useRouter();
  const toast = useToast();
  const canManage = permissions.includes(PERM.manage);
  const missingPublish = permissions.includes(PERM.publish) ? [] : [PERM.publish];
  const critical = kind === 'critical';

  const draftSet = sets.find((s) => s.status === 'draft');
  const publishedSet = sets.find((s) => s.status === 'published');
  const [selectedId, setSelectedId] = useState((draftSet ?? sets[0])?.id);
  const set = sets.find((s) => s.id === selectedId) ?? sets[0];
  const editable = canManage && set?.status === 'draft';

  const [bandsBySet, setBandsBySet] = useState<Record<string, Band[]>>({});
  const bands = set ? (bandsBySet[set.id] ?? set.bands) : [];
  const setBands = (b: Band[]) => set && setBandsBySet((s) => ({ ...s, [set.id]: b }));

  const [fail, setFail] = useState<Fail>();
  const [rowErrors, setRowErrors] = useState<Record<string, Partial<Record<ColId, string>>>>({});
  const [dialog, setDialog] = useState<'publish' | 'retire' | 'discard' | null>(null);

  const specById = useMemo(() => new Map(specimenTypes.map((s) => [s.id, s.code])), [specimenTypes]);
  const specByCode = useMemo(() => new Map(specimenTypes.map((s) => [s.code.toUpperCase(), s.id])), [specimenTypes]);

  const columns: EditableGridColumn[] = [
    { id: 'sex', header: 'Sex', maxLength: 6 },
    { id: 'agefrom', header: 'Age from', maxLength: 12 },
    { id: 'ageto', header: 'Age to', maxLength: 12 },
    { id: 'specimen', header: 'Specimen type', maxLength: 32 },
    ...(critical ? [] : [{ id: 'kind', header: 'Kind', maxLength: 7 }]),
    { id: 'low', header: critical ? 'Critical low' : 'Low', maxLength: 32 },
    { id: 'high', header: critical ? 'Critical high' : 'High', maxLength: 32 },
    { id: 'codes', header: critical ? 'Abnormal codes' : 'Normal codes', maxLength: 340 },
    ...(critical ? [] : [{ id: 'text', header: 'Display text', maxLength: 500 }]),
  ];
  const cellValues = (b: Band): Record<string, string> => ({
    sex: b.sex ?? 'any',
    agefrom: ageText(b.age_low),
    ageto: ageText(b.age_high),
    specimen: b.specimen_type_id ? (specById.get(b.specimen_type_id) ?? b.specimen_type_id) : '',
    kind: b.kind ?? 'numeric',
    low: b.low ?? '',
    high: b.high ?? '',
    codes: (critical ? b.abnormal_codes : b.normal_codes)?.join(', ') ?? '',
    text: b.display_text ?? '',
  });
  const rows: EditableGridRow[] = bands.map((b, i) => {
    const errs = rowErrors[String(i)];
    return { id: String(i), values: cellValues(b), ...(errs ? { status: 'error' as const, errors: errs as Record<string, string> } : {}) };
  });

  const onCell = (rowId: string, col: string, value: string) => {
    const i = Number(rowId);
    const cur = bands[i];
    if (!cur) return;
    const next: Band = { ...cur };
    const err = (m: string) => setRowErrors((e) => ({ ...e, [rowId]: { ...e[rowId], [col]: m } }));
    const ok = () => setRowErrors((e) => { const { [col as ColId]: _drop, ...rest } = e[rowId] ?? {}; return { ...e, [rowId]: rest }; });
    const v = value.trim();
    if (col === 'sex') { if (!SEX_VALUES.includes(v)) return err('Sex must be any, male or female'); next.sex = v; }
    else if (col === 'agefrom' || col === 'ageto') {
      const a = parseAge(v);
      if (a === 'bad') return err('Enter an age such as 18 years');
      if (col === 'agefrom') { if (a) next.age_low = a; else delete next.age_low; }
      else if (a) next.age_high = a; else delete next.age_high;
    } else if (col === 'specimen') {
      if (!v) delete next.specimen_type_id;
      else { const id = specByCode.get(v.toUpperCase()); if (!id) return err('Unknown specimen type'); next.specimen_type_id = id; }
    } else if (col === 'kind') { if (!KINDS.includes(v)) return err('Kind must be numeric, text or ordinal'); next.kind = v; }
    else if (col === 'low' || col === 'high') {
      if (v && !DEC.test(v)) return err('Enter a decimal number such as 13.0');
      if (v) next[col] = v; else delete next[col];
    } else if (col === 'codes') {
      const list = v ? v.split(',').map((c) => c.trim()).filter(Boolean) : [];
      if (list.some((c) => !CODE.test(c))) return err('Codes use A–Z, 0–9, _ + - (max 16 characters)');
      if (critical) next.abnormal_codes = list; else next.normal_codes = list;
    } else if (col === 'text') { if (v) next.display_text = value; else delete next.display_text; }
    ok();
    setBands(bands.map((b, j) => (j === i ? next : b)));
  };

  /** Row-level checks before PUT: Low ≤ High, Age to > Age from, numeric needs a bound (04-UI-UX §4). */
  const validate = (): boolean => {
    const found: Record<string, Partial<Record<ColId, string>>> = {};
    bands.forEach((b, i) => {
      const e: Partial<Record<ColId, string>> = {};
      if (b.low && b.high && DEC.test(b.low) && DEC.test(b.high) && Number(b.low) > Number(b.high)) e.low = 'Low must not exceed High';
      const [from, to] = [ageDays(b.age_low), ageDays(b.age_high)];
      if (from !== undefined && to !== undefined && to <= from) e.ageto = 'Age to must be greater than Age from';
      if (!critical && (b.kind ?? 'numeric') === 'numeric' && !b.low && !b.high) e.low = 'A numeric band needs a Low or a High';
      if (Object.keys(e).length) found[String(i)] = e;
    });
    setRowErrors(found);
    return Object.keys(found).length === 0;
  };

  /** Server errors[] with /bands/{i}[/field] paths → highlighted cells. */
  const placeServerErrors = (errors: readonly FieldError[] = []) => {
    const found: Record<string, Partial<Record<ColId, string>>> = {};
    for (const e of errors) {
      const m = /^\/bands\/(\d+)(?:\/(\w+))?/.exec(e.path ?? '');
      if (!m) continue;
      const col = FIELD_COL[m[2] ?? ''] ?? 'agefrom';
      (found[m[1]!] ??= {})[col] = e.message;
    }
    setRowErrors(found);
    return Object.keys(found).length > 0;
  };

  const done = (title: string) => { setFail(undefined); setDialog(null); toast.show({ tone: 'success', title }); router.refresh(); };
  const save = async () => {
    if (!set || !validate()) return;
    const r = await replaceBandsAction(kind, set.id, set.version, bands.map((b, i) => {
      if (!critical) return { ...b, sort_order: i };
      const { sort_order: _drop, ...rest } = b; // 02-TRD §3 CriticalBand has no sort_order; the API rejects unknown fields
      return rest;
    }));
    if (r.ok) done('Bands saved.');
    else { placeServerErrors(r.errors); setFail(r); }
  };
  const newVersion = async () => {
    const r = await createRangeSetDraftAction(kind, analyte.id, publishedSet ? { copy_from_set_id: publishedSet.id } : {}, newKey());
    if (r.ok) done('Draft created.'); else setFail(r);
  };
  const discard = async () => {
    if (!draftSet) return;
    const r = await discardRangeSetAction(kind, draftSet.id, draftSet.version);
    if (r.ok) done('Draft discarded.'); else { setDialog(null); setFail(r); }
  };
  const addBand = () => setBands([...bands, { sex: 'any', ...(critical ? {} : { kind: 'numeric', sort_order: bands.length }) }]);

  return (
    <div className="lims-stack catalog-gap-3">
      {fail ? <FailBanner fail={fail} /> : null}
      {sets.length === 0 ? <p>{EMPTY[kind]}</p> : null}
      {sets.length > 0 ? (
        <ul className="lims-inline catalog-gap-2 catalog-plain-list" aria-label="Versions">
          {sets.map((s) => (
            <li key={s.id}>
              <Button size="sm" variant={s.id === set?.id ? 'primary' : 'secondary'} onPress={() => setSelectedId(s.id)}>{`v${s.version_no}`}</Button>{' '}
              <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="lims-inline catalog-gap-2">
        {canManage ? <Button isDisabled={!!draftSet} onPress={() => void newVersion()}>New version</Button> : null}
        {canManage && draftSet ? <Button variant="danger" onPress={() => setDialog('discard')}>Discard draft</Button> : null}
        {draftSet ? <GatedButton variant="primary" missing={missingPublish} onPress={() => setDialog('publish')}>Publish…</GatedButton> : null}
        {set?.status === 'published' ? <GatedButton missing={missingPublish} onPress={() => setDialog('retire')}>Retire…</GatedButton> : null}
      </div>
      {set ? (
        <>
          <p className="lims-description">{AGE_RULE}</p>
          <EditableGrid label={critical ? 'Critical limit bands' : 'Reference range bands'} columns={columns} rows={rows} isReadOnly={!editable} onCellChange={onCell} />
          {editable ? (
            <div className="lims-inline catalog-gap-2">
              <Button onPress={addBand}>Add band</Button>
              <Button isDisabled={bands.length <= 1} onPress={() => setBands(bands.slice(0, -1))}>Remove last band</Button>
              <Button variant="primary" onPress={() => void save()}>Save</Button>
            </div>
          ) : null}
        </>
      ) : null}
      {set && (dialog === 'publish' || dialog === 'retire') ? (
        <SetActionDialog
          mode={dialog}
          kind={kind}
          set={dialog === 'publish' ? (draftSet ?? set) : set}
          analyteCode={analyte.code}
          onClose={() => setDialog(null)}
          onDone={(t) => done(t)}
          onFail={(r) => {
            if (r.code === 'auth.mfa_required') return true; // the dialog says so and the retry re-sends the same key
            setFail(placeServerErrors(r.errors) ? { ...r, errors: [] } : r); // band errors are shown on their rows, not repeated here
            setDialog(null);
            return false;
          }}
        />
      ) : null}
      {dialog === 'discard' ? (
        <Dialog title="Discard draft" isOpen onClose={() => setDialog(null)} size="sm" footer={<><Button variant="ghost" onPress={() => setDialog(null)}>Cancel</Button><Button variant="danger" onPress={() => void discard()}>Discard</Button></>}>
          <p>The draft and its edits are removed. The published version is not affected.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

/** Publish… / Retire… (AC-05.9): change reason 1–500 + typed analyte code; Idempotency-Key kept across the step-up retry. */
function SetActionDialog({ mode, kind, set, analyteCode, onClose, onDone, onFail }: {
  mode: 'publish' | 'retire';
  kind: RangeKind;
  set: RangeSet;
  analyteCode: string;
  onClose: () => void;
  onDone: (title: string) => void;
  /** Returns true when the dialog should stay open (e.g. step-up needed). */
  onFail: (r: Fail) => boolean;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string>();
  const [key] = useState(newKey);
  const [stay, setStay] = useState<Fail>();
  const [busy, setBusy] = useState(false);
  const verb = mode === 'publish' ? 'Publish' : 'Retire';

  const submit = async () => {
    if (busy) return;
    if (typed !== analyteCode) return setTypedError(`Type ${analyteCode} exactly to confirm`);
    setTypedError(undefined);
    setBusy(true);
    try {
      const body = { change_reason: reason };
      const r = mode === 'publish' ? await publishRangeSetAction(kind, set.id, set.version, body, key) : await retireRangeSetAction(kind, set.id, set.version, body, key);
      if (r.ok) onDone(`${analyteCode} ${kind === 'ranges' ? 'reference range' : 'critical limit'} version ${set.version_no} ${mode === 'publish' ? 'published' : 'retired'}.`);
      else if (onFail(r)) setStay(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={`${verb} version ${set.version_no}`} isOpen onClose={onClose} size="md">
      <Form onSubmit={submit} errorSummary={false}>
        {stay ? <FailBanner fail={stay} /> : null}
        <TextArea label="Change reason" name="change_reason" maxLength={500} isRequired value={reason} onChange={setReason} />
        <TextField label={`Type ${analyteCode} to confirm`} name="confirm" maxLength={32} isRequired value={typed} onChange={setTyped} {...(typedError ? { error: typedError } : {})} />
        <p>Requires two-step verification</p>
        <div className="lims-inline catalog-gap-2 catalog-end">
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy}>{verb}</Button>
        </div>
      </Form>
    </Dialog>
  );
}
