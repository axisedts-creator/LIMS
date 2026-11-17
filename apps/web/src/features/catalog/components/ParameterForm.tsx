'use client';
// T0D-TESTMGMT-1 item (4), LD-318 (ElabAssist Add / Edit Test Parameter): every AnalyteCreate field; the fields shown depend on the
// result type. Result type names map to the API as catalog.yaml AnalyteVersionDraftInput says: Equation = numeric + formula_expression,
// List = coded, Long text = text + long_text_value, Narrative (Descriptive) = narrative. Ordinal / Narrative keep the web-t32 names.
// The Equation box validates as you type (POST /v1/catalog/formulas/validate, debounced) and lists the parameters it may use
// (LD-318 follow-up: OWN_SHORT_NAME=expression over the short names = codes of the other parameters of the same test).
// Create = POST /tests/{id}/analytes (Idempotency-Key). Edit = PATCH the analyte (changed fields) + PATCH the draft version when there is one;
// a published version is read-only (edit = Create new version), publish goes through PublishDialog (catalog.reference_range.publish).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createAnalyteVersionDraftAction, validateFormulaAction } from '../server/actions';
import { createAnalyteFullAction, updateAnalyteFullAction, updateVersionDraftFullAction } from '../server/testMgmtActions';
import type { FieldError } from '../server/types';
import { Check, GridSection, intOf, MiniSelect } from './compact-ui';
import { PublishDialog } from './PublishDialog';
import { errAt, FailBanner, newKey, PERM, STATUS_LABEL, type Fail } from './shared';

type Rec = Record<string, any>;
const TYPES = [
  ['numeric', 'Numeric'], ['equation', 'Equation'], ['ordinal', 'Ordinal'], ['list', 'List'], ['text', 'Text'], ['long_text', 'Long text'], ['narrative', 'Narrative'],
  ['space', 'Space'], ['boolean', 'Boolean'], ['attachment', 'Image'], ['test_footer', 'Test footer'], ['graph', 'Graph'], ['html_descriptive', 'HTML descriptive'],
].map(([value, label]) => ({ value: value!, label: label! }));
const API_TYPE: Record<string, string> = { equation: 'numeric', list: 'coded', long_text: 'text' };
const DISPLAY = [
  ['table', 'Table'], ['note_value_only', 'Note, value only'], ['list_note', 'List note'], ['one_column', 'One column'], ['two_column', 'Two column'], ['three_column', 'Three column'],
  ['four_column', 'Four column'], ['comment', 'Comment'], ['hidden', 'Hidden'], ['table_with_subheader', 'Table with sub heading'], ['merge_two_column', 'Merge two column'],
].map(([value, label]) => ({ value: value!, label: label! }));
const FLAGS = [['print_on_negative', 'Print on negative value'], ['print_on_worksheet', 'Print on worksheet'], ['send_in_sms', 'Send result in SMS'], ['nabl', 'NABL'], ['accab_logo', 'ACCAB logo'], ['is_trend', 'Trend report']] as const;
const NUMERIC = new Set(['numeric', 'equation']);
const VALUE_SET = new Set(['ordinal', 'list']);
const TEXT_AREA = new Set(['long_text', 'narrative', 'html_descriptive']);
const WITH_DEFAULT = new Set(['numeric', 'equation', 'ordinal', 'list', 'text']);
const WITH_METHOD = new Set(['numeric', 'equation', 'ordinal', 'list', 'text']);
const CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const DEC_RE = /^-?\d{1,12}(\.\d{1,6})?$/;
const LONG_MAX = 20_000;
const NONE = 'none';

/** UI result type of a stored version (formula = Equation; coded = List; text with a long text = Long text). */
export const uiTypeOf = (v: Rec | undefined) => {
  const t = String(v?.['result_type'] ?? 'numeric');
  if (t === 'numeric' && v?.['formula_expression']) return 'equation';
  if (t === 'coded') return 'list';
  if (t === 'text' && v?.['long_text_value']) return 'long_text';
  return t;
};
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export function ParameterForm({ testId, analyte, siblings, units, methods, valueSets, rangeDraft, criticalDraft, permissions }: {
  testId: string;
  /** null = new parameter; otherwise GET /v1/catalog/analytes/{id} (AnalyteDetail with versions). */
  analyte: Rec | null;
  /** Codes (short names) of the other parameters of this test: what an equation may use. */
  siblings: readonly string[];
  units: readonly { code: string; display: string }[];
  methods: readonly { id: string; name: string; is_active: boolean }[];
  valueSets: readonly { code: string; display: string }[];
  rangeDraft?: { id: string; version_no: number; version: number } | undefined;
  criticalDraft?: { id: string; version_no: number; version: number } | undefined;
  permissions: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const isCreate = analyte === null;
  const manage = permissions.includes(PERM.manage);
  const versions = (analyte?.['versions'] ?? []) as Rec[];
  const draft = versions.find((v) => v['status'] === 'draft');
  const shown = draft ?? versions.find((v) => v['status'] === 'published') ?? analyte?.['current_version'] ?? versions[0];
  const clinicalOff = !manage || (!isCreate && !draft);
  const off = !manage;

  const [a, setA] = useState(() => ({
    code: str(analyte?.['code']), name: str(analyte?.['name']), print_name: str(analyte?.['print_name']), report_subheading: str(analyte?.['report_subheading']),
    trend_name: str(analyte?.['trend_name']), font: str(analyte?.['font']), result_display_type: str(analyte?.['result_display_type']), sort_order: str(analyte?.['sort_order']),
  }));
  const [flags, setFlags] = useState<Record<string, boolean>>(() => Object.fromEntries(FLAGS.map(([k]) => [k, analyte ? (k === 'print_on_negative' ? analyte[k] !== false : !!analyte[k]) : k === 'print_on_negative'])));
  const [type, setType] = useState(() => uiTypeOf(shown));
  const [c, setC] = useState(() => ({
    unit_code: str(shown?.['unit_code']), decimals: str(shown?.['decimals']), method_id: str(shown?.['method_id']), value_set_code: str(shown?.['value_set_code']),
    formula_expression: str(shown?.['formula_expression']), default_value: str(shown?.['default_value']), long_text_value: str(shown?.['long_text_value']), high_low: str(shown?.['high_low']),
  }));
  const [requireVerification, setRequireVerification] = useState(!!shown?.['require_verification']);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fail, setFail] = useState<Fail>();
  const [check, setCheck] = useState<{ valid: boolean; codes: string[]; errors: FieldError[] } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [key] = useState(newKey);
  const busy = useRef(false);

  const setAf = (k: keyof typeof a) => (v: string) => { setA((o) => ({ ...o, [k]: k === 'code' ? v.toUpperCase() : v })); setErrors(({ [k]: _d, ...r }) => r); };
  const setCf = (k: keyof typeof c) => (v: string) => { setC((o) => ({ ...o, [k]: v })); setErrors(({ [k]: _d, ...r }) => r); };
  const err = (k: string) => (errors[k] ? { error: errors[k] } : {});
  const usable = siblings.filter((x) => x !== a.code);

  // Equation: validate as you type (debounced so five keystrokes are not five requests).
  const expr = type === 'equation' ? c.formula_expression.trim() : '';
  useEffect(() => {
    if (!expr) { setCheck(null); return; }
    let live = true;
    const h = setTimeout(() => {
      void validateFormulaAction({ expression: expr, ...(analyte?.['id'] ? { analyte_id: String(analyte['id']) } : {}) }).then((r) => {
        if (live && r.ok) setCheck({ valid: r.data.valid, codes: r.data.input_analyte_codes, errors: r.data.errors });
      });
    }, 350);
    return () => { live = false; clearTimeout(h); };
  }, [expr, analyte]);

  /** Clinical definition: only what applies to the chosen type (switching type never leaves stale fields behind). */
  const definition = (e: Record<string, string>): Rec => {
    const d: Rec = { result_type: API_TYPE[type] ?? type, require_verification: requireVerification };
    if (NUMERIC.has(type)) {
      const n = intOf(c.decimals, 0, 6);
      if (n === undefined || Number.isNaN(n)) e['decimals'] = 'Decimals: a whole number from 0 to 6.';
      else d['decimals'] = n;
      if (c.unit_code) d['unit_code'] = c.unit_code;
      if (c.high_low.trim()) { if (DEC_RE.test(c.high_low.trim())) d['high_low'] = c.high_low.trim(); else e['high_low'] = 'Enter a decimal number such as 13.0.'; }
    }
    if (type === 'equation') { if (c.formula_expression.trim()) d['formula_expression'] = c.formula_expression.trim(); else e['formula_expression'] = 'Enter the formula, for example TG/5.'; }
    if (VALUE_SET.has(type)) { if (c.value_set_code) d['value_set_code'] = c.value_set_code; else e['value_set_code'] = 'Choose a value set.'; }
    if (WITH_METHOD.has(type) && c.method_id) d['method_id'] = c.method_id;
    if (WITH_DEFAULT.has(type) && c.default_value.trim()) d['default_value'] = c.default_value.trim();
    if (TEXT_AREA.has(type) && c.long_text_value.trim()) {
      if (c.long_text_value.length > LONG_MAX) e['long_text_value'] = `At most ${LONG_MAX} characters.`;
      else d['long_text_value'] = c.long_text_value;
    }
    return d;
  };
  const analyteFields = (e: Record<string, string>): Rec => {
    const o: Rec = {};
    if (!a.name.trim()) e['name'] = 'Name is required.';
    else o['name'] = a.name.trim();
    for (const k of ['print_name', 'report_subheading', 'trend_name', 'font', 'result_display_type'] as const) if (a[k].trim()) o[k] = a[k].trim();
    const n = intOf(a.sort_order, 0, 9999);
    if (Number.isNaN(n)) e['sort_order'] = 'Display order: a whole number from 0 to 9999.';
    else if (n !== undefined) o['sort_order'] = n;
    for (const [k] of FLAGS) o[k] = flags[k];
    return o;
  };

  const place = (r: Fail) => {
    const found: Record<string, string> = {};
    for (const x of r.errors ?? []) { const k = /\/([a-z_]+)$/.exec(x.path ?? '')?.[1]; if (k) found[k] = x.message; }
    if (r.code === 'catalog.code_duplicate') found['code'] = 'This code is already used in this test.';
    setErrors(found);
    setFail(Object.keys(found).length ? undefined : r);
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy.current || off) return;
    const e: Record<string, string> = {};
    const fields = analyteFields(e);
    const def = definition(e);
    if (isCreate && !CODE_RE.test(a.code.trim())) e['code'] = 'Code: starts with a capital letter, then A-Z, 0-9 or _, up to 32 characters.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setFail(undefined);
    busy.current = true;
    try {
      if (isCreate) {
        const r = await createAnalyteFullAction(testId, { code: a.code.trim(), ...fields, initial_version: def }, key);
        if (!r.ok) return place(r);
        toast.show({ tone: 'success', title: `Parameter ${r.data.code} created.` });
        router.push(`/catalog/tests/${testId}?tab=analytes&analyte=${r.data.id}`);
        return;
      }
      const patch: Rec = {};
      const unset: string[] = [];
      const blankable = new Set(['print_name', 'report_subheading']);
      for (const k of ['name', 'print_name', 'report_subheading', 'sort_order', ...FLAGS.map(([f]) => f)]) {
        const v = fields[k] ?? (blankable.has(k) ? '' : undefined);
        const was = analyte![k] ?? (blankable.has(k) ? '' : k === 'print_on_negative' ? true : FLAGS.some(([f]) => f === k) ? false : undefined);
        if (v !== undefined && v !== was) patch[k] = v;
      }
      for (const k of ['trend_name', 'font', 'result_display_type']) {
        if (fields[k] !== undefined && fields[k] !== analyte![k]) patch[k] = fields[k];
        else if (fields[k] === undefined && analyte![k]) unset.push(k);
      }
      if (unset.length) patch['unset'] = unset;
      if (Object.keys(patch).length) {
        const r = await updateAnalyteFullAction(String(analyte!['id']), Number(analyte!['version']), patch);
        if (!r.ok) return place(r);
      }
      if (draft && manage) {
        const was: Rec = draft;
        const vpatch: Rec = {};
        for (const [k, v] of Object.entries(def)) if (v !== was[k]) vpatch[k] = v;
        const gone = ['unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression', 'default_value', 'long_text_value', 'high_low'].filter((k) => was[k] !== undefined && was[k] !== null && !(k in def));
        if (gone.length) vpatch['unset'] = gone;
        if (Object.keys(vpatch).length) {
          const r = await updateVersionDraftFullAction(String(draft['id']), Number(draft['version']), vpatch);
          if (!r.ok) return place(r);
        }
      }
      toast.show({ tone: 'success', title: 'Parameter saved.' });
      router.refresh();
    } finally {
      busy.current = false;
    }
  };

  const newVersion = async () => {
    const r = await createAnalyteVersionDraftAction(String(analyte!['id']), newKey());
    if (r.ok) { toast.show({ tone: 'success', title: `Draft version ${r.data.version_no} created.` }); router.refresh(); } else setFail(r);
  };

  const methodOpts = methods.filter((m) => m.is_active || m.id === c.method_id).map((m) => ({ value: m.id, label: m.name }));
  const formulaError = errors['formula_expression'] ?? errAt(fail, '/initial_version/formula_expression', '/formula_expression');
  return (
    <div className="lims-stack catalog-gap-2">
      {!isCreate && shown ? <p className="lims-description">{`Version ${shown['version_no'] ?? ''} · ${STATUS_LABEL[String(shown['status'])] ?? shown['status'] ?? ''}${clinicalOff && manage ? ' · read-only: create a new version to change the result definition' : ''}`}</p> : null}
      {off ? <p className="lims-description">Requires permission catalog.test.manage to change parameters.</p> : null}
      {fail ? <FailBanner fail={fail} /> : null}
      <form noValidate className="catalog-dense-form" onSubmit={(e) => void submit(e)}>
        <GridSection title="Parameter" columns={4}>
          <TextField label="Code" name="code" maxLength={32} isRequired={isCreate} isDisabled={off || !isCreate} isReadOnly={!isCreate} description="Short name used in equations" value={a.code} onChange={setAf('code')} {...err('code')} />
          <TextField label="Name" name="name" maxLength={120} isRequired isDisabled={off} value={a.name} onChange={setAf('name')} {...err('name')} />
          <TextField label="Print name" name="print_name" maxLength={120} isDisabled={off} value={a.print_name} onChange={setAf('print_name')} {...err('print_name')} />
          <TextField label="Sub heading" name="report_subheading" maxLength={80} isDisabled={off} value={a.report_subheading} onChange={setAf('report_subheading')} {...err('report_subheading')} />
          <TextField label="Trend report name" name="trend_name" maxLength={120} isDisabled={off} value={a.trend_name} onChange={setAf('trend_name')} {...err('trend_name')} />
          <TextField label="Font" name="font" maxLength={60} isDisabled={off} value={a.font} onChange={setAf('font')} {...err('font')} />
          <MiniSelect label="Result display type" isDisabled={off} value={a.result_display_type || NONE} onChange={(v) => setAf('result_display_type')(v === NONE ? '' : v)} options={[{ value: NONE, label: 'Default' }, ...DISPLAY]} error={errors['result_display_type']} />
          <TextField label="Display order" name="sort_order" maxLength={4} inputMode="numeric" isDisabled={off} value={a.sort_order} onChange={setAf('sort_order')} {...err('sort_order')} />
        </GridSection>
        <GridSection title="Result" columns={4}>
          <MiniSelect label="Result type" isRequired isDisabled={clinicalOff} value={type} onChange={(v) => { setType(v); setErrors({}); }} options={TYPES} error={errors['result_type']} />
          {NUMERIC.has(type) ? (
            <>
              <MiniSelect label="Unit" isDisabled={clinicalOff} value={c.unit_code || NONE} onChange={(v) => setCf('unit_code')(v === NONE ? '' : v)} options={[{ value: NONE, label: 'No unit' }, ...units.map((u) => ({ value: u.code, label: u.display }))]} error={errors['unit_code']} />
              <TextField label="Decimals" name="decimals" maxLength={1} inputMode="numeric" isRequired isDisabled={clinicalOff} value={c.decimals} onChange={setCf('decimals')} {...err('decimals')} />
              <TextField label="High low" name="high_low" maxLength={20} inputMode="decimal" isDisabled={clinicalOff} value={c.high_low} onChange={setCf('high_low')} {...err('high_low')} />
            </>
          ) : null}
          {VALUE_SET.has(type) ? (
            <MiniSelect label="Value set" isRequired isDisabled={clinicalOff} value={c.value_set_code} onChange={setCf('value_set_code')} options={valueSets.map((s) => ({ value: s.code, label: s.display }))} error={errors['value_set_code']} />
          ) : null}
          {WITH_METHOD.has(type) ? (
            <MiniSelect label="Method" isDisabled={clinicalOff} value={c.method_id || NONE} onChange={(v) => setCf('method_id')(v === NONE ? '' : v)} options={[{ value: NONE, label: 'No method' }, ...methodOpts]} error={errors['method_id']} />
          ) : null}
          {WITH_DEFAULT.has(type) ? <TextField label="Default value" name="default_value" maxLength={500} isDisabled={clinicalOff} value={c.default_value} onChange={setCf('default_value')} {...err('default_value')} /> : null}
          <Check label="Require verification" isDisabled={clinicalOff} checked={requireVerification} onChange={setRequireVerification} />
        </GridSection>
        {type === 'equation' ? (
          <div className="lims-stack catalog-gap-1">
            <TextField label="Formula" name="formula_expression" maxLength={500} isRequired isDisabled={clinicalOff} description="Written over the short names of the other parameters, for example TG/5" value={c.formula_expression} onChange={setCf('formula_expression')} {...(formulaError ? { error: formulaError } : {})} />
            <p className="lims-description">{`Parameters this formula may use: ${usable.length ? usable.join(', ') : 'none yet'}`}</p>
            {check && !check.valid && check.errors.length ? <ul className="lims-error" role="status">{check.errors.map((x, i) => <li key={i}>{x.message}</li>)}</ul> : null}
            {check?.valid ? <p role="status" className="lims-description">{`Formula is valid${check.codes.length ? `; it uses ${check.codes.join(', ')}` : ''}.`}</p> : null}
          </div>
        ) : null}
        {TEXT_AREA.has(type) ? (
          // [CONV] maxLength one above the API limit so an over-long paste is reported, not silently cut
          <TextArea label="Text value" name="long_text_value" maxLength={LONG_MAX + 1} rows={4} isDisabled={clinicalOff} value={c.long_text_value} onChange={setCf('long_text_value')} {...err('long_text_value')} />
        ) : null}
        <GridSection title="Flags" columns={6}>
          {FLAGS.map(([k, label]) => <Check key={k} label={label} isDisabled={off} checked={!!flags[k]} onChange={(on) => setFlags((f) => ({ ...f, [k]: on }))} />)}
        </GridSection>
        <div className="lims-inline catalog-gap-2">
          {manage ? <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Save</Button> : null}
          {manage && !isCreate && !draft ? <Button onPress={() => void newVersion()}>Create new version</Button> : null}
          {manage && !isCreate && draft ? <Button onPress={() => setPublishing(true)}>Publish…</Button> : null}
          <Button variant="ghost" onPress={() => router.push(`/catalog/tests?view=details&test=${testId}`)}>Back to test details</Button>
        </div>
      </form>
      {!isCreate && draft ? (
        <PublishDialog
          analyte={{ id: String(analyte!['id']), code: String(analyte!['code']), name: String(analyte!['name']) }}
          version={{ id: String(draft['id']), version_no: Number(draft['version_no']), version: Number(draft['version']) }}
          rangeDraft={rangeDraft}
          criticalDraft={criticalDraft}
          unitOrMethodChanged={false}
          permissions={permissions}
          isOpen={publishing}
          onClose={() => setPublishing(false)}
        />
      ) : null}
    </div>
  );
}
