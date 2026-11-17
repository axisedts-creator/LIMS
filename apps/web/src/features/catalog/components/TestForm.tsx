'use client';
// T0D-TESTMGMT-1 done_when (3) (LD-318): Add / Edit / Copy Test on /catalog/tests?view=details&form=new|edit|copy[&test=<id>]. Every
// TestCreate / TestUpdate field of contracts/openapi/catalog.yaml in four compact fieldsets (Basics, Report, Flags, Turnaround), side labels
// (T0D-DENSITY-1 labelPlacement="start"), no tabs, no collapsed section, no scroll box, so it fits 1366 x 768. Required fields carry
// `required`. The seven stage TAT targets are minutes (PUT tat-targets after the test is saved). A live report preview beside the form uses
// sample data only (never a patient). Edit sends only the changed fields (If-Match); Copy opens the form pre-filled with an empty code and
// name and always creates a new test (POST).
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { useToast } from '@lims/ui/components/Toast';
import { createTestAction, updateTestAction } from '../server/actions';
import { setTestTatTargetsAction } from '../server/testmgmtActions';
import { newKey } from './shared';
import { Check, ErrorList, failText, placeErrors, ReadOnlyNote, SelectIn, TextIn, type ServerError } from './tm-ui';
import { detailsHref } from './TestDetails';
import './catalog.css';

type Ref = { id: string; name: string; code?: string; report_label?: string; is_active?: boolean };
const WORKFLOWS = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'];
const REPORT_TYPES: [string, string][] = [['four_column', 'Four column'], ['three_column', 'Three column'], ['two_column', 'Two column'], ['graph', 'Graph'], ['template_based_html', 'Template based HTML'], ['micro_automated', 'Micro automated'], ['cbc_four_column', 'CBC four column'], ['micro_manual', 'Micro manual'], ['histo', 'Histo'], ['four_column_10_font', 'Four column 10 font']];
const PROCESSING: [string, string][] = [['local', 'Local'], ['branch_transfer', 'Branch Transfer'], ['outsource_branch', 'Outsource To Other Branch']]; // LD-318 follow-up (3)
export const STAGES: [string, string][] = [['registration', 'Registration'], ['sample_collection', 'Sample collection'], ['accession', 'Accession'], ['result', 'Result'], ['approval_1', 'Approval 1'], ['approval_2', 'Approval 2'], ['release', 'Release']];
const TEXTS = ['code', 'name', 'department_id', 'workflow_type', 'category_id', 'short_name', 'display_name', 'barcode_text', 'description', 'report_type', 'processing_type', 'template_ref', 'outsource_name', 'font'] as const;
const INTS = ['loyalty_points', 'display_order', 'report_order', 'alert_before_expiry_minutes'] as const;
const LISTS = ['tags', 'nabl_processing_centres'] as const;
const FLAGS: [string, string][] = [['is_orderable', 'Orderable'], ['uses_existing_material', 'Uses existing material'], ['is_outsourced', 'Outsourced'], ['is_popular', 'Popular'], ['smart_report', 'Smart report'], ['print_category_wise', 'Print category wise'], ['nabl', 'NABL'], ['accab_logo', 'ACCAB logo'], ['auto_approval_enabled', 'Auto approval'], ['use_normal_range_for_auto_approval', 'Use normal range for auto approval'], ['template_test', 'Template test']];
/** TestUpdate.unset values: an emptied optional field is cleared, not sent blank. */
const UNSETTABLE = new Set(['short_name', 'display_name', 'barcode_text', 'description', 'template_ref', 'outsource_name', 'nabl_processing_centres', 'font', 'alert_before_expiry_minutes', 'category_id', 'report_type', 'processing_type']);
const CREATE_ONLY = new Set(['code', 'specimen']);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type State = Record<string, string> & { flags: Record<string, boolean>; stages: Record<string, string>; specimen: string };

function fromTest(t: Record<string, any> | undefined, specimens: readonly Ref[], copy: boolean): State {
  const s: State = { flags: {}, stages: {}, specimen: '' } as State;
  for (const k of TEXTS) s[k] = t?.[k] != null ? String(t[k]) : '';
  for (const k of INTS) s[k] = t?.[k] != null ? String(t[k]) : '';
  for (const k of LISTS) s[k] = Array.isArray(t?.[k]) ? (t[k] as string[]).join(', ') : '';
  for (const [k] of FLAGS) s.flags[k] = t ? !!t[k] : k === 'is_orderable';
  for (const st of (t?.['stage_targets'] ?? []) as { stage: string; target_minutes: number }[]) s.stages[st.stage] = String(st.target_minutes);
  const req = ((t?.['specimen_requirements'] ?? []) as { specimen_type_id: string; is_preferred?: boolean }[]);
  const pref = req.find((r) => r.is_preferred) ?? req[0];
  s.specimen = specimens.find((x) => x.id === pref?.specimen_type_id)?.code ?? '';
  if (copy) { s['code'] = ''; s['name'] = ''; }
  return s;
}
const splitList = (v: string) => [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];

/** Normalised request fields of a form state (blank optional = absent). */
function fieldsOf(s: State): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of TEXTS) if (s[k]!.trim()) o[k] = k === 'code' ? s[k]!.trim() : s[k];
  for (const k of INTS) if (s[k]!.trim() !== '') o[k] = Number(s[k]);
  for (const k of LISTS) { const l = splitList(s[k]!); if (l.length) o[k] = l; }
  for (const [k] of FLAGS) o[k] = !!s.flags[k];
  return o;
}
/** LD-318 follow-up (1): ElabAssist style display name NAME, SPECIMEN(CODE); editable after the suggestion. */
const suggestDisplay = (s: State, specimens: readonly Ref[]) => {
  const sp = specimens.find((x) => x.code === s.specimen);
  return `${(s['name'] ?? '').trim().toUpperCase()}${sp ? `, ${sp.report_label ?? sp.name}` : ''}(${(s['code'] ?? '').trim().toUpperCase()})`;
};
const stagesOf = (s: State) => STAGES.filter(([k]) => (s.stages[k] ?? '').trim() !== '').map(([k]) => ({ stage: k, target_minutes: Number(s.stages[k]) }));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function TestForm({ mode, test, departments, categories, specimens, manage }: {
  mode: 'new' | 'edit' | 'copy';
  test?: Record<string, any> | undefined;
  departments: readonly Ref[];
  categories: readonly (Ref & { department_id?: string })[];
  specimens: readonly Ref[];
  manage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const initial = useMemo(() => fromTest(test, specimens, mode === 'copy'), [test, specimens, mode]);
  const [s, setS] = useState<State>(initial);
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<Record<string, string>>({});
  const [other, setOther] = useState<string[]>([]);
  const editing = mode === 'edit' && !!test;
  const ro = !manage;

  const set = (k: string) => (v: string) => { setS((x) => ({ ...x, [k]: v })); setAt((e) => { const { [k]: _d, ...r } = e; return r; }); };
  const text = (k: string, label: string, o: { required?: boolean; max?: number; area?: boolean; cssLabel?: boolean; hint?: string } = {}) => (
    <TextIn label={label} value={s[k] ?? ''} onChange={set(k)} maxLength={o.max ?? 200} required={!!o.required} area={!!o.area} readOnly={ro || (editing && CREATE_ONLY.has(k))} error={at[k]} {...(o.cssLabel ? { cssLabel: true } : {})} {...(o.hint ? { hint: o.hint } : {})} />
  );
  const num = (k: string, label: string, max: number) => <TextIn label={label} type="number" min={0} max={max} value={s[k] ?? ''} onChange={set(k)} readOnly={ro} error={at[k]} />;
  const select = (k: string, label: string, options: [string, string][], o: { required?: boolean; blank?: string } = {}) => (
    <SelectIn label={label} value={s[k] ?? ''} onChange={set(k)} options={options.map(([value, l]) => ({ value, label: l }))} required={!!o.required} blank={o.blank ?? 'Choose…'} readOnly={ro || (editing && CREATE_ONLY.has(k))} error={at[k]} />
  );

  /** Client checks the API would refuse anyway (LD-318: no dirty data). */
  const check = (f: Record<string, unknown>): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!editing) for (const k of ['code', 'name', 'department_id', 'workflow_type'] as const) if (!f[k]) e[k] = 'Required.';
    if (!editing && !s.specimen) e['specimen'] = 'Choose the specimen.';
    if (f['is_orderable'] && !(f['tags'] as string[] | undefined)?.length) e['tags'] = 'Add at least one tag: an orderable test needs a tag so it can be found.';
    if (typeof f['display_name'] === 'string' && f['display_name'].trim().length < 3) e['display_name'] = 'At least 3 characters.';
    for (const k of INTS) { const v = f[k]; if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0)) e[k] = 'Enter a whole number, 0 or more.'; }
    for (const [k] of STAGES) { const v = s.stages[k]; if (v && !(/^\d{1,5}$/.test(v) && Number(v) <= 43200)) e[`stage_${k}`] = 'Minutes, 0 to 43200.'; }
    return e;
  };

  const save = async () => {
    if (busy || ro) return;
    const f = fieldsOf(s);
    const errs = check(f);
    setAt(errs); setOther([]);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      let id = test?.['id'] as string | undefined;
      let version = test?.['version'] as number | undefined;
      if (editing) {
        const before = fieldsOf(initial);
        const body: Record<string, unknown> = {};
        const unset: string[] = [];
        for (const k of new Set([...Object.keys(before), ...Object.keys(f)])) {
          if (CREATE_ONLY.has(k) || same(before[k], f[k])) continue;
          if (f[k] === undefined) { if (UNSETTABLE.has(k)) unset.push(k); } else body[k] = f[k];
        }
        if (unset.length) body['unset'] = unset;
        if (Object.keys(body).length) {
          const r = await updateTestAction(id!, version!, body);
          if (!r.ok) return showFail(r);
          version = r.data.version;
        }
      } else {
        const spec = specimens.find((x) => x.code === s.specimen);
        const r = await createTestAction({ ...f, specimen_requirements: spec ? [{ specimen_type_id: spec.id, is_preferred: true }] : [] }, key);
        if (!r.ok) return showFail(r);
        id = r.data.id; version = r.data.version;
      }
      const stages = stagesOf(s);
      if (!same(stages, stagesOf(initial)) || (!editing && stages.length)) {
        // routine / urgent targets (seconds) are kept as they are: TatTargetsSet replaces both lists
        const targets = ((test?.['tat_targets'] ?? []) as Record<string, unknown>[]).slice(0, 2).map((t) => ({ priority: t['priority'], segment: t['segment'], target_seconds: t['target_seconds'] })) as never[];
        const r = await setTestTatTargetsAction(id!, version!, { targets: editing ? targets : [], stage_targets: stages as never[] });
        if (!r.ok) { setOther([`The test was saved but the turnaround targets were not: ${failText(r.code)}`]); return; }
      }
      toast.show({ tone: 'success', title: editing ? 'Test saved.' : 'Test created.' });
      router.push(detailsHref({ test: id }));
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  const showFail = (r: { code: string; errors?: ServerError[] }) => {
    const { at: a, other: o } = placeErrors(r.errors, [...TEXTS, ...INTS, ...LISTS, 'specimen_requirements']);
    if (r.code === 'catalog.code_duplicate' && !a['code']) a['code'] = 'This code is already used.';
    setAt(a);
    setOther(o.length || Object.keys(a).length ? o : [failText(r.code)]);
  };

  const deptOpts = departments.filter((d) => d.is_active !== false || d.id === s['department_id']).map((d) => [d.id, d.name] as [string, string]);
  const catOpts = categories.filter((c) => !s['department_id'] || !c.department_id || c.department_id === s['department_id']).map((c) => [c.id, c.name] as [string, string]);
  const title = mode === 'edit' ? `Edit test ${test?.['code'] ?? ''}` : mode === 'copy' ? `Copy of ${test?.['code'] ?? 'test'}` : 'New test';

  return (
    <section aria-label={title} className="lims-stack catalog-gap-2">
      <div className="lims-inline catalog-gap-2">
        <h1 className="lims-page-title">{title}</h1>
        <a href={detailsHref({ test: test?.['id'] })}>Back to test details</a>
      </div>
      {manage ? null : <ReadOnlyNote />}
      <div className="tm-form-row">
        <form aria-label="Test" noValidate className="lims-form tm-form" data-label-placement="start" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="tm-sections">
            <fieldset aria-label="Basics" className="tm-section">
              <legend className="lims-section-title">Basics</legend>
              {text('code', 'Code', { required: true, max: 32, hint: editing ? 'Set when the test was created.' : 'Capital letters, digits and _, up to 32.' })}
              {text('name', 'Name', { required: true })}
              {text('display_name', 'Display name', { max: 300, hint: 'NAME, SPECIMEN(CODE)' })}
              {ro ? null : <Button size="sm" variant="ghost" onPress={() => set('display_name')(suggestDisplay(s, specimens))}>Suggest display name</Button>}
              {text('short_name', 'Short name', { max: 60 })}
              {select('department_id', 'Department', deptOpts, { required: true })}
              {select('category_id', 'Category', catOpts, { blank: 'None' })}
              {select('workflow_type', 'Workflow type', WORKFLOWS.map((w) => [w, cap(w)]), { required: true })}
              <SelectIn label="Specimen" value={s.specimen} onChange={(v) => { setS((x) => ({ ...x, specimen: v })); setAt((e) => ({ ...e, specimen: '' })); }} options={specimens.filter((x) => x.is_active !== false && x.code).map((x) => ({ value: x.code!, label: x.name }))} blank="Choose…" required={!editing} readOnly={ro || editing} error={at['specimen'] || undefined} />
              {text('tags', 'Tags', { max: 1300, cssLabel: true, hint: 'Comma separated search words.' })}
              {text('barcode_text', 'Barcode text', { max: 64 })}
              {num('loyalty_points', 'Loyalty points', 1_000_000)}
              {num('display_order', 'Display order', 9999)}
              {num('report_order', 'Report order', 9999)}
              {text('description', 'Description', { max: 2000, area: true })}
            </fieldset>
            <fieldset aria-label="Report" className="tm-section">
              <legend className="lims-section-title">Report</legend>
              {select('report_type', 'Report type', REPORT_TYPES)}
              {select('processing_type', 'Processing type', PROCESSING)}
              {text('template_ref', 'Template', { max: 120 })}
              {text('outsource_name', 'Outsource name', { max: 200 })}
              {text('font', 'Font', { max: 60 })}
            </fieldset>
            <fieldset aria-label="Flags" className="tm-section">
              <legend className="lims-section-title">Flags</legend>
              {FLAGS.map(([k, l]) => <Check key={k} label={l} checked={!!s.flags[k]} disabled={ro} onChange={(v) => setS((x) => ({ ...x, flags: { ...x.flags, [k]: v } }))} />)}
              {text('nabl_processing_centres', 'NABL processing centres', { max: 4200 })}
            </fieldset>
            <fieldset aria-label="Turnaround" className="tm-section">
              <legend className="lims-section-title">Turnaround</legend>
              {num('alert_before_expiry_minutes', 'Alert before expiry (minutes)', 525_600)}
              <p className="lims-description">Target per step in minutes (0 to 43200).</p>
              {STAGES.map(([k, l]) => (
                <TextIn key={k} label={l} type="number" min={0} max={43200} value={s.stages[k] ?? ''} readOnly={ro} error={at[`stage_${k}`]}
                  onChange={(v) => setS((x) => ({ ...x, stages: { ...x.stages, [k]: v } }))} />
              ))}
            </fieldset>
          </div>
          <ErrorList errors={other} />
          <div className="lims-inline catalog-gap-2">
            {manage ? <Button type="submit" variant="primary" isDisabled={busy}>Save</Button> : null}
            {mode === 'edit' && test ? <Button onPress={() => router.push(detailsHref({ form: 'copy', test: test['id'] as string }))}>Copy test</Button> : null}
            <Button variant="ghost" onPress={() => router.push(detailsHref({ test: test?.['id'] }))}>Cancel</Button>
          </div>
        </form>
        <ReportPreview s={s} departments={departments} specimens={specimens} />
      </div>
    </section>
  );
}

/** Live report preview from the form state and fixed sample values. Never reads a patient. */
function ReportPreview({ s, departments, specimens }: { s: State; departments: readonly Ref[]; specimens: readonly Ref[] }) {
  const dept = departments.find((d) => d.id === s['department_id'])?.name ?? 'Department';
  const spec = specimens.find((x) => x.code === s.specimen)?.name ?? '';
  return (
    <section aria-label="Report preview" className="tm-preview lims-card">
      <h2 className="lims-section-title">Report preview</h2>
      <p className="lims-description">Sample data only (not a real person).</p>
      <dl className="lims-dl tm-patient">
        <dt>Patient</dt><dd>A. Example</dd>
        <dt>Age / Sex</dt><dd>35 Y / Female</dd>
        <dt>Specimen</dt><dd>{spec || '-'}</dd>
      </dl>
      <p className="lims-section-title">{dept}</p>
      <table className="lims-table lims-table-compact">
        <thead><tr><th scope="col">Test Name</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Reference Range</th></tr></thead>
        <tbody>
          <tr><td>{s['display_name'] || s['name'] || 'Test name'}</td><td>12.5</td><td>g/dL</td><td>12.0 - 15.5</td></tr>
        </tbody>
      </table>
    </section>
  );
}
