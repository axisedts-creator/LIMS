'use client';
// T0D-TESTMGMT-1 done_when (4) (LD-318): Add / Edit Parameter on /catalog/tests?view=details&test=<id>&parameter=new|<analyte_id>.
// Every AnalyteCreate field plus the version fields; what is shown depends on the ElabAssist result type (catalog.yaml mapping:
// Integer / Float / Equation = numeric, Equation sets formula_expression; List = coded; Long / Single Line Text = text; Descriptive =
// narrative; Image = attachment; the rest by name). Equation: formula box validated by the server as you type (debounced) + the
// parameters of this test it may use (short names). Hidden fields are never sent. Editing a published parameter opens a draft version
// (POST analytes/{id}/versions) and PATCHes it; this form never publishes (LD-318 decision 2: publish stays a separate permission).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { useToast } from '@lims/ui/components/Toast';
import { createAnalyteAction, createAnalyteVersionDraftAction, updateAnalyteAction, updateAnalyteVersionDraftAction, validateFormulaAction } from '../server/actions';
import { newKey } from './shared';
import { Check, ErrorList, failText, placeErrors, ReadOnlyNote, SelectIn, TextIn, type ServerError } from './tm-ui';
import { detailsHref, type Param } from './TestDetails';
import './catalog.css';

type Opt = { value: string; label: string };
/** ElabAssist result type → contract result_type (catalog.yaml AnalyteVersionDraftInput.result_type description). */
const TYPES: [string, string][] = [['Integer', 'numeric'], ['Float', 'numeric'], ['Equation', 'numeric'], ['List', 'coded'], ['Long Text', 'text'], ['Single Line Text', 'text'], ['Descriptive', 'narrative'], ['Image', 'attachment'], ['Boolean', 'boolean'], ['Space', 'space'], ['Graph', 'graph'], ['Html Descriptive', 'html_descriptive'], ['Test Footer', 'test_footer']];
const NUMERIC = new Set(['Integer', 'Float', 'Equation']);
const TEXTY = new Set(['Long Text', 'Descriptive']);
const DISPLAY = ['table', 'note_value_only', 'list_note', 'one_column', 'two_column', 'three_column', 'four_column', 'comment', 'hidden', 'table_with_subheader', 'merge_two_column'];
const FLAGS: [string, string, boolean][] = [['is_reportable', 'Reportable', true], ['print_on_negative', 'Print on negative', true], ['print_on_worksheet', 'Print on worksheet', false], ['send_in_sms', 'Send in SMS', false], ['nabl', 'NABL', false], ['accab_logo', 'ACCAB logo', false], ['is_trend', 'Is trend', false]];
const A_TEXT = ['name', 'print_name', 'report_subheading', 'trend_name', 'font', 'result_display_type', 'specimen_type_id'] as const;
const DEC = /^-?\d{1,12}(\.\d{1,6})?$/;
const cap = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' ');

function uiType(v: Record<string, any> | undefined): string {
  const t = v?.['result_type'] ?? 'numeric';
  if (t === 'numeric') return v?.['formula_expression'] ? 'Equation' : v?.['decimals'] === 0 ? 'Integer' : 'Float';
  if (t === 'coded' || t === 'ordinal') return 'List';
  if (t === 'text') return v?.['long_text_value'] ? 'Long Text' : 'Single Line Text';
  if (t === 'narrative') return 'Descriptive';
  return TYPES.find(([, c]) => c === t)?.[0] ?? 'Float';
}

type S = Record<string, string> & { flags: Record<string, boolean>; type: string };
function fromAnalyte(a: Record<string, any> | undefined, v: Record<string, any> | undefined): S {
  const s = { flags: {}, type: uiType(v) } as S;
  s['code'] = a?.['code'] ?? '';
  for (const k of A_TEXT) s[k] = a?.[k] != null ? String(a[k]) : '';
  s['sort_order'] = a?.['sort_order'] != null ? String(a['sort_order']) : '';
  for (const [k, , d] of FLAGS) s.flags[k] = a?.[k] != null ? !!a[k] : d;
  for (const k of ['unit_code', 'method_id', 'value_set_code', 'formula_expression', 'default_value', 'long_text_value', 'high_low']) s[k] = v?.[k] != null ? String(v[k]) : '';
  s['decimals'] = v?.['decimals'] != null ? String(v['decimals']) : '';
  s.flags['require_verification'] = !!v?.['require_verification'];
  return s;
}

/** Analyte-level request fields. */
function analyteOf(s: S): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of A_TEXT) if (s[k]!.trim()) o[k] = s[k];
  if (s['sort_order']!.trim() !== '') o['sort_order'] = Number(s['sort_order']);
  for (const [k] of FLAGS) o[k] = !!s.flags[k];
  return o;
}
/** Version fields that the chosen result type shows; hidden ones are dropped. */
function versionOf(s: S): Record<string, unknown> {
  const o: Record<string, unknown> = { result_type: TYPES.find(([l]) => l === s.type)?.[1] ?? 'numeric' };
  const put = (k: string) => { if (s[k]!.trim() !== '') o[k] = s[k]; };
  if (s.type !== 'Space') { put('unit_code'); put('method_id'); o['require_verification'] = !!s.flags['require_verification']; }
  if (NUMERIC.has(s.type)) { if (s['decimals']!.trim() !== '') o['decimals'] = Number(s['decimals']); put('high_low'); }
  if (s.type === 'Integer' && o['decimals'] === undefined) o['decimals'] = 0;
  if (s.type === 'Equation') put('formula_expression');
  if (s.type === 'List') { put('value_set_code'); put('default_value'); }
  if (TEXTY.has(s.type)) put('long_text_value');
  return o;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function ParameterForm({ testId, testCode, analyte, version, siblings, units, methods, valueSets, specimens, manage }: {
  testId: string;
  testCode: string;
  analyte?: Record<string, any> | undefined;
  version?: Record<string, any> | undefined;
  siblings: readonly Param[];
  units: readonly Opt[];
  methods: readonly Opt[];
  valueSets: readonly Opt[];
  specimens: readonly Opt[];
  manage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const initial = useMemo(() => fromAnalyte(analyte, version), [analyte, version]);
  const [s, setS] = useState<S>(initial);
  const [key] = useState(newKey);
  const [at, setAt] = useState<Record<string, string>>({});
  const [other, setOther] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formula, setFormula] = useState<{ state: 'idle' | 'checking' | 'valid' | 'invalid'; messages: string[] }>({ state: 'idle', messages: [] });
  const editing = !!analyte;
  const ro = !manage;
  const usable = siblings.filter((p) => p.id !== analyte?.['id'] && p.is_active !== false && (p.current_version?.['result_type'] ?? 'numeric') === 'numeric');

  // Server formula check as you type, 400 ms after the last keystroke (validation never saves).
  const seq = useRef(0);
  const expr = s.type === 'Equation' ? s['formula_expression']!.trim() : '';
  useEffect(() => {
    if (!expr) { setFormula({ state: 'idle', messages: [] }); return; }
    const n = ++seq.current;
    setFormula((f) => ({ ...f, state: 'checking' }));
    const t = setTimeout(() => {
      void validateFormulaAction({ expression: expr.slice(0, 500), ...(analyte?.['id'] ? { analyte_id: analyte['id'] as string } : {}) }).then((r) => {
        if (n !== seq.current) return;
        if (!r.ok) setFormula({ state: 'invalid', messages: [failText(r.code)] });
        else setFormula({ state: r.data.valid ? 'valid' : 'invalid', messages: r.data.errors.map((e) => e.message) });
      });
    }, 400);
    return () => clearTimeout(t);
  }, [expr, analyte]);

  const set = (k: string) => (v: string) => { setS((x) => ({ ...x, [k]: v })); setAt((e) => { const { [k]: _d, ...r } = e; return r; }); };
  const text = (k: string, label: string, o: { required?: boolean; max?: number; area?: boolean; readOnly?: boolean; type?: 'number'; min?: number; maxN?: number } = {}) => (
    <TextIn label={label} value={s[k] ?? ''} onChange={set(k)} maxLength={o.max ?? 120} required={!!o.required} area={!!o.area} readOnly={ro || !!o.readOnly} error={at[k]}
      {...(o.type ? { type: o.type, min: o.min ?? 0, max: o.maxN ?? 9999 } : {})} />
  );
  const select = (k: string, label: string, options: readonly Opt[], blank = 'None') => <SelectIn label={label} value={s[k] ?? ''} onChange={set(k)} options={options} blank={blank} readOnly={ro} error={at[k]} />;

  const check = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!s['name']!.trim()) e['name'] = 'Required.';
    if (!editing && !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(s['code']!.trim())) e['code'] = 'Start with a letter; letters, digits and _, up to 32.';
    if (NUMERIC.has(s.type) && s['decimals'] && !(/^\d$/.test(s['decimals']) && Number(s['decimals']) <= 6)) e['decimals'] = 'Decimals 0 to 6.';
    if (NUMERIC.has(s.type) && s['high_low'] && !DEC.test(s['high_low'])) e['high_low'] = 'A decimal number such as 99.9.';
    if (s.type === 'Equation' && !s['formula_expression']!.trim()) e['formula_expression'] = 'Enter the formula.';
    if (s.type === 'List' && !s['value_set_code']) e['value_set_code'] = 'Choose the value set.';
    return e;
  };

  const showFail = (r: { code: string; errors?: ServerError[] }) => {
    const { at: a, other: o } = placeErrors(r.errors, ['code', 'name', 'print_name', 'report_subheading', 'sort_order', 'trend_name', 'font', 'initial_version', 'formula_expression', 'decimals', 'value_set_code']);
    if (a['initial_version']) { a['formula_expression'] = a['initial_version']; delete a['initial_version']; }
    if (r.code === 'catalog.code_duplicate' && !a['code']) a['code'] = 'This short name is already used in the test.';
    setAt(a);
    setOther(o.length || Object.keys(a).length ? o : [failText(r.code)]);
  };

  const save = async () => {
    if (busy || ro) return;
    const errs = check();
    setAt(errs); setOther([]);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      if (!editing) {
        const r = await createAnalyteAction(testId, { code: s['code']!.trim().toUpperCase(), ...analyteOf(s), name: s['name']!, initial_version: versionOf(s) } as never, key);
        if (!r.ok) return showFail(r);
      } else {
        const a = analyte!;
        const before = analyteOf(initial), after = analyteOf(s);
        const body: Record<string, unknown> = {};
        const unset: string[] = [];
        for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (same(before[k], after[k])) continue;
          if (after[k] === undefined) { if (['trend_name', 'specimen_type_id', 'font', 'result_display_type'].includes(k)) unset.push(k); } else body[k] = after[k];
        }
        if (unset.length) body['unset'] = unset;
        if (Object.keys(body).length) {
          const r = await updateAnalyteAction(a['id'], a['version'], body);
          if (!r.ok) return showFail(r);
        }
        const vb = versionOf(initial), va = versionOf(s);
        const vbody: Record<string, unknown> = {};
        const vunset: string[] = [];
        for (const k of new Set([...Object.keys(vb), ...Object.keys(va)])) {
          if (same(vb[k], va[k])) continue;
          if (va[k] === undefined) vunset.push(k); else vbody[k] = va[k];
        }
        if (vunset.length) vbody['unset'] = vunset;
        if (Object.keys(vbody).length) {
          let draft = version && version['status'] === 'draft' ? { id: version['id'] as string, version: version['version'] as number } : undefined;
          if (!draft) {
            const d = await createAnalyteVersionDraftAction(a['id'], key);
            if (!d.ok) return showFail(d);
            draft = { id: d.data.id, version: d.data.version };
          }
          const r = await updateAnalyteVersionDraftAction(draft.id, draft.version, vbody as never);
          if (!r.ok) return showFail(r);
        }
      }
      toast.show({ tone: 'success', title: editing ? 'Parameter saved as a draft. Publishing is a separate step.' : 'Parameter added.' });
      router.push(detailsHref({ test: testId }));
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const formulaBlocked = s.type === 'Equation' && (formula.state === 'invalid' || formula.state === 'checking');
  return (
    <section aria-label={editing ? `Edit parameter ${s['code']}` : 'New parameter'} className="lims-stack catalog-gap-2">
      <div className="lims-inline catalog-gap-2">
        <h1 className="lims-page-title">{editing ? `Edit parameter ${initial['code']}` : 'New parameter'} ({testCode})</h1>
        <a href={detailsHref({ test: testId })}>Back to test details</a>
      </div>
      {manage ? null : <ReadOnlyNote />}
      <form aria-label="Parameter" noValidate className="lims-form tm-form" data-label-placement="start" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="tm-sections">
          <fieldset aria-label="Parameter" className="tm-section">
            <legend className="lims-section-title">Parameter</legend>
            {text('name', 'Name', { required: true })}
            {text('print_name', 'Print name')}
            {text('report_subheading', 'Sub heading', { max: 80 })}
            <TextIn label="Short name" value={s['code']!} onChange={set('code')} maxLength={32} required readOnly={ro || editing} error={at['code']} hint="Used in equations; fixed once saved." />
            {text('sort_order', 'Sort order', { type: 'number' })}
            {text('trend_name', 'Trend name')}
            {select('specimen_type_id', 'Specimen', specimens)}
            {text('font', 'Font', { max: 60 })}
            {select('result_display_type', 'Result display type', DISPLAY.map((d) => ({ value: d, label: cap(d) })))}
            {FLAGS.map(([k, l]) => <Check key={k} label={l} checked={!!s.flags[k]} disabled={ro} onChange={(v) => setS((x) => ({ ...x, flags: { ...x.flags, [k]: v } }))} />)}
          </fieldset>
          <fieldset aria-label="Result" className="tm-section">
            <legend className="lims-section-title">Result</legend>
            <SelectIn label="Result type" value={s.type} onChange={(v) => setS((x) => ({ ...x, type: v }))} options={TYPES.map(([l]) => ({ value: l, label: l }))} readOnly={ro} />
            {s.type !== 'Space' ? <>
              {select('unit_code', 'Unit', units)}
              {select('method_id', 'Method', methods)}
              <Check label="Require verification" checked={!!s.flags['require_verification']} disabled={ro} onChange={(v) => setS((x) => ({ ...x, flags: { ...x.flags, require_verification: v } }))} />
            </> : null}
            {NUMERIC.has(s.type) ? <>
              {text('decimals', 'Decimals', { type: 'number', maxN: 6 })}
              {text('high_low', 'High low', { max: 20 })}
            </> : null}
            {s.type === 'Equation' ? <>
              <TextIn label="Formula" value={s['formula_expression']!} onChange={set('formula_expression')} maxLength={500} readOnly={ro} error={at['formula_expression']} hint="Short names of this test's parameters, for example TG/5." />
              <p aria-live="polite" className={formula.state === 'invalid' ? 'lims-error' : 'lims-description'}>
                {formula.state === 'valid' ? 'Formula is valid.' : formula.state === 'checking' ? 'Checking the formula…' : null}
              </p>
              <ErrorList errors={formula.state === 'invalid' ? formula.messages : []} />
              <ul aria-label="Parameters it may use" className="catalog-plain-list tm-chips">
                {usable.map((p) => <li key={p.id}>{p.code} <span className="lims-description">{p.name}</span></li>)}
                {usable.length === 0 ? <li className="lims-description">No other numeric parameter in this test yet.</li> : null}
              </ul>
            </> : null}
            {s.type === 'List' ? <>
              {select('value_set_code', 'Value set', valueSets, 'Choose…')}
              {text('default_value', 'Default value', { max: 500 })}
            </> : null}
            {TEXTY.has(s.type) ? text('long_text_value', 'Text', { area: true, max: 20000 }) : null}
          </fieldset>
        </div>
        <ErrorList errors={other} />
        <div className="lims-inline catalog-gap-2">
          {manage ? <Button type="submit" variant="primary" isDisabled={busy || formulaBlocked}>Save</Button> : null}
          <Button variant="ghost" onPress={() => router.push(detailsHref({ test: testId }))}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}
