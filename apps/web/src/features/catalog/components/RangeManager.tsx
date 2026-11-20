'use client';
// T0D-TESTMGMT-1 item (5), LD-318 (ElabAssist Reference Range Manage): one grid per analyte with Range Name, Age From, Age To, Age Unit,
// Sex, Laboratory, Instrument, Default, Normal Low / High, Critical Low / High, Auto Approved Low / High, Display Text, Method; inline
// row editor (kit EditableGrid: Enter edits, Enter commits), client rules shown in the row, server errors[] placed on their row and cell,
// a Draft / Published badge (text), and Publish only with catalog.reference_range.publish. Critical Low / High live in the analyte's
// critical limit set (matched by sex + ages) and are saved there (no sort_order). Decimals stay strings. Range Name is derived (a LIMS
// band has no stored name); Laboratory and Instrument are read-only ids until the API lists them [CONV].
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { EditableGrid, type EditableGridColumn, type EditableGridRow } from '@lims/ui/components/EditableGrid';
import { useToast } from '@lims/ui/components/Toast';
import { createRangeSetDraftAction, replaceBandsAction } from '../server/actions';
import type { Age, Band, FieldError, RangeSet } from '../server/types';
import { ReportPreview } from './compact-ui';
import { SetActionDialog } from './RangesTab';
import { FailBanner, newKey, PERM, STATUS_LABEL, STATUS_TONE, type Fail } from './shared';

type Rec = Record<string, any>;
const COLS = [
  ['name', 'Range Name'], ['age_from', 'Age From'], ['age_to', 'Age To'], ['age_unit', 'Age Unit'], ['sex', 'Sex'], ['lab', 'Laboratory'], ['instrument', 'Instrument'],
  ['def', 'Default'], ['low', 'Normal Low'], ['high', 'Normal High'], ['crit_low', 'Critical Low'], ['crit_high', 'Critical High'], ['aa_low', 'Auto Approved Low'],
  ['aa_high', 'Auto Approved High'], ['text', 'Display Text'], ['method', 'Method'],
] as const;
type Col = (typeof COLS)[number][0];
const READ_ONLY = new Set<Col>(['name', 'lab', 'instrument']);
const MAX: Partial<Record<Col, number>> = { age_from: 3, age_to: 3, age_unit: 5, sex: 12, def: 3, text: 500, method: 120 };
const SEXES = ['any', 'male', 'female', 'third_gender'];
const UNITS: Record<string, number> = { hour: 1, day: 24, week: 168, month: 720, year: 8760 }; // hours; client ordering checks only
const DEC = /^-?\d{1,12}(\.\d{1,6})?$/;
const DECIMAL_COLS: Col[] = ['low', 'high', 'crit_low', 'crit_high', 'aa_low', 'aa_high'];
const LABEL = Object.fromEntries(COLS) as Record<Col, string>;

type Row = Record<Col, string> & { carry: Band & Rec };
const sameAge = (a?: Age, b?: Age) => (a?.value ?? null) === (b?.value ?? null) && (a?.unit ?? null) === (b?.unit ?? null);
const matchCrit = (b: Band, crit: readonly Band[]) => crit.find((c) => (c.sex ?? 'any') === (b.sex ?? 'any') && sameAge(c.age_low, b.age_low) && sameAge(c.age_high, b.age_high));
const ageKey = (r: Row) => `${r.sex}|${r.age_from}|${r.age_to}|${r.age_unit}`;

function rowOf(b: Band & Rec, crit: readonly Band[], methods: ReadonlyMap<string, string>): Row {
  const c = matchCrit(b, crit);
  const r = {
    sex: b.sex ?? 'any', age_from: b.age_low ? String(b.age_low.value) : '', age_to: b.age_high ? String(b.age_high.value) : '', age_unit: b.age_low?.unit ?? b.age_high?.unit ?? 'year',
    lab: b['laboratory_id'] ?? '', instrument: b['instrument_id'] ?? '', def: b['default_range'] ? 'Yes' : 'No', low: b.low ?? '', high: b.high ?? '', crit_low: c?.low ?? '', crit_high: c?.high ?? '',
    aa_low: b['auto_approved_low'] ?? '', aa_high: b['auto_approved_high'] ?? '', text: b.display_text ?? '', method: b['method_id'] ? (methods.get(b['method_id']) ?? b['method_id']) : '', name: '', carry: b,
  } as Row;
  return r;
}
const nameOf = (r: Row) => [r.sex.replace('_', ' '), r.age_from || r.age_to ? `${r.age_from || '0'}–${r.age_to || '…'} ${r.age_unit}` : 'all ages', r.lab ? 'lab' : '', r.instrument ? 'instrument' : ''].filter(Boolean).join(', ');
const hours = (v: string, unit: string, open: number) => (v === '' ? open : Number(v) * (UNITS[unit] ?? 0));

/** Client rules (cell -> message per row). Messages name the column so each one is clear on its own. */
function validate(rows: readonly Row[]): Record<string, Partial<Record<Col, string>>> {
  const out: Record<string, Partial<Record<Col, string>>> = {};
  const put = (i: number, c: Col, m: string) => { (out[String(i)] ??= {})[c] ??= m; };
  rows.forEach((r, i) => {
    if (!SEXES.includes(r.sex)) put(i, 'sex', 'Sex must be any, male, female or third_gender');
    if (!(r.age_unit in UNITS)) put(i, 'age_unit', 'Unit must be year, month, week, day or hour');
    for (const c of ['age_from', 'age_to'] as const) if (r[c] !== '' && !/^\d{1,3}$/.test(r[c])) put(i, c, `${LABEL[c]}: a whole number from 0 to 200`);
    if (r.age_from !== '' && r.age_to !== '' && Number(r.age_to) <= Number(r.age_from)) put(i, 'age_to', 'Age To must be greater than Age From');
    if (!['Yes', 'No'].includes(r.def)) put(i, 'def', 'Default: Yes or No');
    for (const c of DECIMAL_COLS) if (r[c] !== '' && !DEC.test(r[c])) put(i, c, `${LABEL[c]} must be a decimal number such as 13.0`);
    const n = (c: Col) => (r[c] !== '' && DEC.test(r[c]) ? Number(r[c]) : undefined);
    const [lo, hi, cl, ch, al, ah] = [n('low'), n('high'), n('crit_low'), n('crit_high'), n('aa_low'), n('aa_high')];
    if (lo !== undefined && hi !== undefined && lo > hi) put(i, 'low', 'Normal Low must not exceed Normal High');
    if (cl !== undefined && lo !== undefined && cl >= lo) put(i, 'crit_low', 'Critical Low must be below Normal Low');
    if (ch !== undefined && hi !== undefined && ch <= hi) put(i, 'crit_high', 'Critical High must be above Normal High');
    if (al !== undefined && ah !== undefined && al > ah) put(i, 'aa_low', 'Auto Approved Low must not exceed Auto Approved High');
  });
  // Overlap: same sex, laboratory and instrument; ages compared in hours (lower bound included, upper bound not).
  rows.forEach((a, i) => rows.forEach((b, j) => {
    if (j <= i || a.sex !== b.sex || a.lab !== b.lab || a.instrument !== b.instrument || !(a.age_unit in UNITS) || !(b.age_unit in UNITS)) return;
    const [a0, a1, b0, b1] = [hours(a.age_from, a.age_unit, 0), hours(a.age_to, a.age_unit, Infinity), hours(b.age_from, b.age_unit, 0), hours(b.age_to, b.age_unit, Infinity)];
    if (a0 < b1 && b0 < a1) for (const k of [i, j]) put(k, 'name', 'Overlaps another band of the same sex, laboratory and instrument');
  }));
  return out;
}

const SERVER_COL: Record<string, Col> = {
  sex: 'sex', age_low: 'age_from', age_high: 'age_to', low: 'low', high: 'high', default_range: 'def', auto_approved_low: 'aa_low', auto_approved_high: 'aa_high',
  display_text: 'text', method_id: 'method', laboratory_id: 'lab', instrument_id: 'instrument',
};

export function RangeManager({ analyte, sets, criticalSets, methods, permissions }: {
  analyte: { id: string; code: string; name: string; unit?: string | undefined };
  sets: readonly RangeSet[];
  criticalSets: readonly RangeSet[];
  methods: readonly { id: string; name: string; is_active: boolean }[];
  permissions: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const manage = permissions.includes(PERM.manage);
  const canPublish = manage && permissions.includes(PERM.publish);
  const set = sets.find((s) => s.status === 'draft') ?? sets.find((s) => s.status === 'published') ?? sets[0];
  const published = sets.find((s) => s.status === 'published');
  const crit = criticalSets.find((s) => s.status === 'draft') ?? criticalSets.find((s) => s.status === 'published');
  const editable = manage && (!set || set.status === 'draft');
  const methodName = useMemo(() => new Map(methods.map((m) => [m.id, m.name])), [methods]);
  const methodId = useMemo(() => new Map(methods.map((m) => [m.name.toLowerCase(), m.id])), [methods]);

  const initial = useMemo(() => (set?.bands ?? []).map((b) => rowOf(b as Band & Rec, crit?.bands ?? [], methodName)), [set, crit, methodName]);
  const [rows, setRows] = useState<Row[]>(initial);
  const [serverErrors, setServerErrors] = useState<Record<string, Partial<Record<Col, string>>>>({});
  const [fail, setFail] = useState<Fail>();
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emptyError, setEmptyError] = useState<string>();
  const [key] = useState(newKey);
  const clientErrors = useMemo(() => validate(rows), [rows]);

  const gridRows: EditableGridRow[] = rows.map((r, i) => {
    const e = { ...serverErrors[String(i)], ...clientErrors[String(i)] };
    const values = Object.fromEntries(COLS.map(([c]) => [c, c === 'name' ? nameOf(r) : r[c]]));
    return { id: String(i), values, ...(Object.keys(e).length ? { status: 'error' as const, errors: e as Record<string, string> } : {}) };
  });
  const columns: EditableGridColumn[] = COLS.map(([id, header]) => ({ id, header, ...(MAX[id] ? { maxLength: MAX[id] } : { maxLength: 24 }), ...(READ_ONLY.has(id) ? { isReadOnly: true } : {}) }));

  const onCell = (rowId: string, col: string, value: string) => {
    const i = Number(rowId);
    let v = value.trim();
    if (col === 'sex' || col === 'age_unit') v = v.toLowerCase();
    if (col === 'def') v = /^(y|yes|true|1)$/i.test(v) ? 'Yes' : /^(n|no|false|0|)$/i.test(v) ? 'No' : v;
    if (col === 'text') v = value;
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [col]: v } : r)));
    setServerErrors({});
  };

  const ageOf = (v: string, unit: string): Age | undefined => (v === '' ? undefined : { value: Number(v), unit });
  const toBand = (r: Row, i: number): Band & Rec => {
    const { carry } = r;
    const b: Band & Rec = { sex: r.sex, kind: carry.kind ?? 'numeric', sort_order: i, default_range: r.def === 'Yes' };
    const lo = ageOf(r.age_from, r.age_unit); const hi = ageOf(r.age_to, r.age_unit);
    if (lo) b.age_low = lo;
    if (hi) b.age_high = hi;
    if (carry.specimen_type_id) b.specimen_type_id = carry.specimen_type_id;
    if (carry.normal_codes?.length) b.normal_codes = carry.normal_codes;
    if (carry['laboratory_id']) b['laboratory_id'] = carry['laboratory_id'];
    if (carry['instrument_id']) b['instrument_id'] = carry['instrument_id'];
    for (const [c, f] of [['low', 'low'], ['high', 'high'], ['aa_low', 'auto_approved_low'], ['aa_high', 'auto_approved_high']] as const) if (r[c] !== '') b[f] = r[c];
    if (r.text.trim()) b.display_text = r.text;
    const m = r.method ? (methodId.get(r.method.toLowerCase()) ?? (methodName.has(r.method) ? r.method : undefined)) : undefined;
    if (m) b['method_id'] = m;
    return b;
  };
  const critBands = (): Band[] => {
    const bands = rows.map((r, i) => ({ r, b: toBand(r, i) })).filter(({ r }) => r.crit_low !== '' || r.crit_high !== '')
      .map(({ r, b }) => ({ sex: b.sex!, ...(b.age_low ? { age_low: b.age_low } : {}), ...(b.age_high ? { age_high: b.age_high } : {}), ...(b.specimen_type_id ? { specimen_type_id: b.specimen_type_id } : {}), ...(r.crit_low ? { low: r.crit_low } : {}), ...(r.crit_high ? { high: r.crit_high } : {}) }));
    const kept = (crit?.bands ?? []).filter((c) => !rows.some((r) => matchCrit(toBand(r, 0), [c])));
    return [...kept.map(({ sort_order: _d, ...c }) => c), ...bands];
  };
  const critChanged = rows.length !== initial.length || rows.some((r, i) => r.crit_low !== initial[i]?.crit_low || r.crit_high !== initial[i]?.crit_high || ageKey(r) !== ageKey(initial[i]!));

  const placeServer = (errors: readonly FieldError[] = []) => {
    const found: Record<string, Partial<Record<Col, string>>> = {};
    for (const e of errors) {
      const m = /^\/bands\/(\d+)(?:\/(\w+))?/.exec(e.path ?? '');
      if (!m) continue;
      (found[m[1]!] ??= {})[SERVER_COL[m[2] ?? ''] ?? 'name'] = e.message;
    }
    setServerErrors(found);
    return Object.keys(found).length > 0;
  };

  const save = async () => {
    if (busy || Object.keys(clientErrors).length) return;
    // Review fix: an existing set cannot be emptied (PUT needs >= 1 band); say so instead of a false "saved".
    if (rows.length === 0 && set) { setEmptyError('A range set needs at least one band; retire the set instead.'); return; }
    setEmptyError(undefined);
    setBusy(true);
    try {
      const bands = rows.map(toBand);
      let sent = false;
      if (bands.length) {
        sent = true;
        const r = set ? await replaceBandsAction('ranges', set.id, set.version, bands) : await createRangeSetDraftAction('ranges', analyte.id, { bands }, key);
        if (!r.ok) { if (!placeServer(r.errors)) setFail(r); else setFail(undefined); return; }
      }
      if (critChanged) {
        const cb = critBands();
        if (cb.length) {
          sent = true;
          const r = crit?.status === 'draft' ? await replaceBandsAction('critical', crit.id, crit.version, cb) : await createRangeSetDraftAction('critical', analyte.id, { bands: cb }, newKey());
          if (!r.ok) { setFail(r); return; }
        }
      }
      setFail(undefined);
      if (!sent) return;
      toast.show({ tone: 'success', title: 'Reference ranges saved.' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  const newVersion = async () => {
    const r = await createRangeSetDraftAction('ranges', analyte.id, published ? { copy_from_set_id: published.id } : {}, newKey());
    if (r.ok) { toast.show({ tone: 'success', title: 'Draft created.' }); router.refresh(); } else setFail(r);
  };

  const first = rows.find((r) => r.def === 'Yes') ?? rows[0];
  const rangeText = !first ? '—' : first.low && first.high ? `${first.low} - ${first.high}` : first.low ? `>= ${first.low}` : first.high ? `<= ${first.high}` : first.text || '—';
  const sample = first?.low && first?.high && DEC.test(first.low) && DEC.test(first.high) ? ((Number(first.low) + Number(first.high)) / 2).toFixed(Math.max(first.low.split('.')[1]?.length ?? 0, 1)) : '—';

  return (
    <div className="lims-stack catalog-gap-2">
      <div className="lims-inline catalog-gap-2">
        <strong>{`${analyte.name} (${analyte.code})`}</strong>
        {set ? <Badge tone={STATUS_TONE[set.status] ?? 'neutral'}>{STATUS_LABEL[set.status] ?? set.status}</Badge> : null}
        {set ? <span className="lims-description">{`Version ${set.version_no}`}</span> : null}
        {canPublish && set?.status === 'draft' ? <Button variant="primary" onPress={() => setPublishing(true)}>Publish…</Button> : null}
        {manage && set && set.status !== 'draft' && !sets.some((s) => s.status === 'draft') ? <Button onPress={() => void newVersion()}>New version</Button> : null}
      </div>
      {fail ? <FailBanner fail={fail} /> : null}
      {emptyError ? <p role="alert" className="lims-error">{emptyError}</p> : null}
      {!set ? <p>No reference ranges yet. Results for this parameter show no range until a band is added and published.</p> : null}
      <div className="catalog-form-with-preview">
        <div className="lims-stack catalog-gap-2">
          <EditableGrid label="Reference range bands" columns={columns} rows={gridRows} isReadOnly={!editable} onCellChange={onCell} />
          {editable ? (
            <div className="lims-inline catalog-gap-2">
              <Button onPress={() => setRows((rs) => [...rs, rowOf({ sex: 'any', kind: 'numeric' }, [], methodName)])}>Add band</Button>
              <Button isDisabled={rows.length === 0} onPress={() => setRows((rs) => rs.slice(0, -1))}>Remove last band</Button>
              <Button variant="primary" isLoading={busy} onPress={() => void save()}>Save</Button>
            </div>
          ) : null}
        </div>
        <ReportPreview rows={[{ name: analyte.name, value: sample, unit: analyte.unit ?? '', range: rangeText }]} />
      </div>
      {publishing && set ? (
        <SetActionDialog
          mode="publish"
          kind="ranges"
          set={set}
          analyteCode={analyte.code}
          onClose={() => setPublishing(false)}
          onDone={(title) => { setPublishing(false); toast.show({ tone: 'success', title }); router.refresh(); }}
          onFail={(r) => { if (r.code === 'auth.mfa_required') return true; setPublishing(false); if (!placeServer(r.errors)) setFail(r); return false; }}
        />
      ) : null}
    </div>
  );
}
