'use client';
// T0D-TESTMGMT-1 item (3), LD-318: Add / Edit Test with every TestCreate / TestUpdate field in four compact sections (Basics, Report,
// Flags, Turnaround) that fit one 1366 x 768 screen, the seven stage TAT inputs in minutes, Copy test, and a live report preview built
// from sample data. LD-318 follow-up (1): the display name is SUGGESTED as NAME, SPECIMEN(CODE) and stays editable.
// Create = POST /v1/catalog/tests (+ PUT tat-targets when stage minutes were entered); edit = PATCH with only the changed fields
// (cleared optional fields as unset[]) + PUT tat-targets / specimen-requirements when those changed. The API enforces permissions.
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Drawer } from '@lims/ui/components/Drawer';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createTestFullAction, replaceSpecimensAction, setTatTargetsAction, updateTestFullAction } from '../server/testMgmtActions';
import { CODE_RE } from '../server/types';
import { Check, GridSection, intOf, MiniSelect, ReportPreview, type PreviewRow } from './compact-ui';
import { FailBanner, newKey, PERM, type Fail } from './shared';

type Rec = Record<string, any>;
type Ref = { id: string; name: string; is_active: boolean };
export type CategoryRef = { id: string; name: string; department_id: string; is_active: boolean };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
const WORKFLOWS = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'].map((w) => ({ value: w, label: cap(w) }));
const REPORT_TYPES = [
  ['four_column', 'Four column'], ['three_column', 'Three column'], ['two_column', 'Two column'], ['graph', 'Graph'], ['template_based_html', 'Template based HTML'],
  ['micro_automated', 'Micro automated'], ['cbc_four_column', 'CBC four column'], ['micro_manual', 'Micro manual'], ['histo', 'Histo'], ['four_column_10_font', 'Four column, 10 font'],
].map(([value, label]) => ({ value: value!, label: label! }));
const PROCESSING = [{ value: 'local', label: 'Local' }, { value: 'branch_transfer', label: 'Branch transfer' }, { value: 'outsource_branch', label: 'Outsource to other branch' }]; // LD-318 follow-up (3)
const FLAGS = [
  ['is_orderable', 'Orderable'], ['uses_existing_material', 'Uses existing material'], ['is_outsourced', 'Outsourced'], ['is_popular', 'Popular'], ['smart_report', 'Smart report'],
  ['print_category_wise', 'Print category wise'], ['nabl', 'NABL'], ['accab_logo', 'ACCAB logo'], ['auto_approval_enabled', 'Auto approval'],
  ['use_normal_range_for_auto_approval', 'Use normal range for auto approval'], ['template_test', 'Template test'],
] as const;
const STAGES = [['registration', 'Registration'], ['sample_collection', 'Sample collection'], ['accession', 'Accession'], ['result', 'Result'], ['approval_1', 'Approval 1'], ['approval_2', 'Approval 2'], ['release', 'Release']] as const;
const NONE = 'none';
const OPTIONAL_TEXT = ['short_name', 'display_name', 'barcode_text', 'description', 'font', 'template_ref', 'outsource_name'] as const;
const INTS = { loyalty_points: ['Loyalty points', 1_000_000], display_order: ['Display order', 9999], report_order: ['Report order', 9999], alert_before_expiry_minutes: ['Alert before expiry', 525_600] } as const;
const UNSETTABLE = new Set(['short_name', 'display_name', 'barcode_text', 'description', 'template_ref', 'outsource_name', 'nabl_processing_centres', 'font', 'alert_before_expiry_minutes', 'category_id', 'report_type', 'processing_type']);
const listOf = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];

type S = Record<string, string>;
function initialText(t: Rec | undefined, copy: boolean): S {
  const s = (k: string) => (t?.[k] === undefined || t?.[k] === null ? '' : String(t[k]));
  const pref = ((t?.['specimen_requirements'] ?? []) as Rec[]).find((r) => r['is_preferred']) ?? (t?.['specimen_requirements'] ?? [])[0];
  return {
    code: copy ? '' : s('code'), name: s('name'), display_name: s('display_name'), short_name: s('short_name'), department_id: s('department_id'), category_id: s('category_id'),
    workflow_type: s('workflow_type'), specimen: pref?.['specimen_type_id'] ?? NONE, tags: ((t?.['tags'] ?? []) as string[]).join(', '), barcode_text: s('barcode_text'),
    loyalty_points: s('loyalty_points'), display_order: s('display_order'), description: s('description'), font: s('font'), report_type: s('report_type'),
    processing_type: s('processing_type'), template_ref: s('template_ref'), outsource_name: s('outsource_name'),
    nabl_processing_centres: ((t?.['nabl_processing_centres'] ?? []) as string[]).join(', '), report_order: s('report_order'), alert_before_expiry_minutes: s('alert_before_expiry_minutes'),
  };
}
const initialFlags = (t: Rec | undefined) => Object.fromEntries([...FLAGS.map(([k]) => [k, t ? !!t[k] : k === 'is_orderable']), ['is_active', t ? t['is_active'] !== false : true]]) as Record<string, boolean>;
const initialStages = (t: Rec | undefined) => Object.fromEntries(STAGES.map(([k]) => [k, String(((t?.['stage_targets'] ?? []) as Rec[]).find((x) => x['stage'] === k)?.['target_minutes'] ?? '')])) as S;

/** Typed values + client errors (field key -> message). Empty optional fields are undefined, never ''. */
function typedOf(s: S, stages: S, isCreate: boolean) {
  const e: Record<string, string> = {};
  const v: Rec = {};
  if (isCreate) {
    if (!s['code']!.trim()) e['code'] = 'Code is required.';
    else if (!CODE_RE.test(s['code']!.trim())) e['code'] = 'Code: capital letters A-Z, digits and _, up to 32 characters.';
  }
  for (const [k, label] of [['name', 'Name'], ['department_id', 'Department'], ['workflow_type', 'Workflow type']] as const) if (!s[k]!.trim()) e[k] = `${label} is required.`;
  for (const k of ['name', 'department_id', 'workflow_type', 'category_id', 'report_type', 'processing_type', ...OPTIONAL_TEXT]) v[k] = s[k]!.trim() || undefined;
  if (v['display_name'] && (v['display_name'] as string).length < 3) e['display_name'] = 'Display name needs at least 3 characters.';
  const tags = listOf(s['tags']!);
  if (tags.length > 20) e['tags'] = 'At most 20 tags.';
  else if (tags.some((x) => x.length > 60)) e['tags'] = 'A tag has at most 60 characters.';
  v['tags'] = tags;
  const centres = listOf(s['nabl_processing_centres']!);
  if (centres.length > 20) e['nabl_processing_centres'] = 'At most 20 centres.';
  v['nabl_processing_centres'] = centres;
  for (const [k, [label, max]] of Object.entries(INTS)) {
    const n = intOf(s[k]!, 0, max);
    if (Number.isNaN(n)) e[k] = `${label}: a whole number from 0 to ${max}.`;
    else v[k] = n;
  }
  const stageTargets: { stage: string; target_minutes: number }[] = [];
  for (const [k, label] of STAGES) {
    const n = intOf(stages[k]!, 0, 43_200);
    if (Number.isNaN(n)) e[`stage.${k}`] = `${label}: minutes from 0 to 43200.`;
    else if (n !== undefined) stageTargets.push({ stage: k, target_minutes: n });
  }
  return { e, v, stageTargets };
}

/** NAME, SPECIMEN(CODE) — the ElabAssist display name (LD-318 follow-up 1). */
const suggestName = (name: string, specimen: string | undefined, code: string) => (name.trim() && specimen && code.trim() ? `${name.trim()}, ${specimen}(${code.trim().toUpperCase()})` : '');

export function TestForm({ mode, test, departments, categories, specimenTypes, permissions, hasPublishedAnalyteVersion = false, onClose }: {
  mode: 'create' | 'edit';
  /** edit: the test; create: the test to copy from (Copy test), if any. */
  test?: Rec | undefined;
  departments: readonly Ref[];
  categories: readonly CategoryRef[];
  specimenTypes: readonly Ref[];
  permissions: readonly string[];
  hasPublishedAnalyteVersion?: boolean;
  onClose?: () => void;
}) {
  const isCreate = mode === 'create';
  const router = useRouter();
  const toast = useToast();
  const canEdit = permissions.includes(PERM.manage);
  const off = !canEdit;
  const [s, setS] = useState<S>(() => initialText(test, isCreate));
  const [flags, setFlags] = useState(() => initialFlags(isCreate && !test ? undefined : test));
  const [stages, setStages] = useState<S>(() => initialStages(test));
  const [dnTouched, setDnTouched] = useState(!isCreate);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fail, setFail] = useState<Fail>();
  const [key] = useState(newKey);
  const busy = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const specimenName = specimenTypes.find((x) => x.id === s['specimen'])?.name;
  const suggestion = suggestName(s['name']!, specimenName, s['code']!);
  const displayName = dnTouched ? s['display_name']! : suggestion || s['display_name']!;
  const set = (k: string) => (v: string) => { setS((o) => ({ ...o, [k]: k === 'code' ? v.toUpperCase() : v })); setErrors(({ [k]: _drop, ...rest }) => rest); };
  const err = (k: string) => (errors[k] ? { error: errors[k] } : {});
  const noEnter = (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) e.preventDefault(); }; // list fields: Enter ends the entry, never submits

  const place = (r: Fail) => {
    const found: Record<string, string> = {};
    for (const x of r.errors ?? []) { const k = /^\/([a-z_]+)/.exec(x.path ?? '')?.[1]; if (k) found[k === 'specimen_requirements' ? 'specimen' : k] = x.message; }
    if (r.code === 'catalog.code_duplicate') found['code'] = 'This code is already used.';
    setErrors(found);
    if (r.code !== 'catalog.code_duplicate') setFail(r);
  };

  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (busy.current || off) return;
    const now = typedOf({ ...s, display_name: displayName }, stages, isCreate);
    setErrors(now.e);
    if (Object.keys(now.e).length) return;
    setFail(undefined);
    busy.current = true;
    try {
      if (isCreate) await create(now);
      else await save(now);
    } finally {
      busy.current = false;
    }
  };

  const create = async ({ v, stageTargets }: ReturnType<typeof typedOf>) => {
    const body: Rec = {
      code: s['code']!.trim(), name: v['name'], department_id: v['department_id'], workflow_type: v['workflow_type'],
      specimen_requirements: s['specimen'] === NONE ? [] : [{ specimen_type_id: s['specimen'], is_preferred: true }], is_orderable: flags['is_orderable'],
    };
    for (const [k, val] of Object.entries(v)) if (!(k in body) && val !== undefined && !(Array.isArray(val) && val.length === 0)) body[k] = val;
    for (const [k] of FLAGS) if (k !== 'is_orderable' && flags[k]) body[k] = true;
    const r = await createTestFullAction(body, key);
    if (!r.ok) return place(r);
    const href = `/catalog/tests/${r.data.id}`;
    if (stageTargets.length) {
      const t = await setTatTargetsAction(r.data.id, r.data.version, { targets: [], stage_targets: stageTargets });
      if (!t.ok) {
        // the test exists now: never create it again; the user fixes the stage targets on its General tab
        toast.show({ tone: 'warning', title: `Test ${body['code']} was created, but its turnaround stage targets were not saved. Set them again on the General tab.` });
        onClose?.();
        router.push(`${href}?tab=general`);
        return;
      }
    }
    toast.show({ tone: 'success', title: `Test ${body['code']} created.` });
    onClose?.();
    router.push(href);
  };

  const save = async ({ v, stageTargets }: ReturnType<typeof typedOf>) => {
    const t = test!;
    const before = typedOf(initialText(t, false), initialStages(t), false);
    const diff: Rec = {};
    const unset: string[] = [];
    for (const [k, val] of Object.entries(v)) {
      const was = before.v[k];
      if (Array.isArray(val) || Array.isArray(was)) {
        const a = (val ?? []) as string[];
        if (a.join('\u0000') === ((was ?? []) as string[]).join('\u0000')) continue;
        if (a.length === 0 && UNSETTABLE.has(k)) unset.push(k);
        else diff[k] = a;
      } else if (val !== was) {
        if (val === undefined) { if (UNSETTABLE.has(k)) unset.push(k); } else diff[k] = val;
      }
    }
    for (const [k, on] of Object.entries(flags)) if (on !== initialFlags(t)[k]) diff[k] = on;
    if (unset.length) diff['unset'] = unset;
    const stagesChanged = STAGES.some(([k]) => (stages[k] ?? '').trim() !== (initialStages(t)[k] ?? ''));
    const specimenChanged = s['specimen'] !== initialText(t, false)['specimen'] && s['specimen'] !== NONE;
    if (!Object.keys(diff).length && !stagesChanged && !specimenChanged) return;
    let version = Number(t['version']);
    if (Object.keys(diff).length) {
      const r = await updateTestFullAction(String(t['id']), version, diff);
      if (!r.ok) return place(r);
      version = r.data.version || version;
    }
    if (specimenChanged) {
      const r = await replaceSpecimensAction(String(t['id']), version, { specimen_requirements: [{ specimen_type_id: s['specimen'], is_preferred: true }] });
      if (!r.ok) return place(r);
      version = r.data.version || version;
    }
    if (stagesChanged) {
      const targets = ((t['tat_targets'] ?? []) as Rec[]).map((x) => ({ priority: x['priority'], segment: x['segment'], target_seconds: x['target_seconds'] }));
      const r = await setTatTargetsAction(String(t['id']), version, { targets, stage_targets: stageTargets });
      if (!r.ok) return place(r);
    }
    toast.show({ tone: 'success', title: 'Test saved.' });
    router.refresh();
  };

  const opt = (list: readonly Ref[], keep?: string) => list.filter((x) => x.is_active || x.id === keep).map((x) => ({ value: x.id, label: x.name }));
  const cats = categories.filter((c) => (!s['department_id'] || c.department_id === s['department_id']) && (c.is_active || c.id === s['category_id']));
  const analytes = ((test?.['analytes'] ?? []) as Rec[]).filter((a) => a['is_active'] !== false).sort((a, b) => a['sort_order'] - b['sort_order']);
  const title = displayName.trim() || s['name']!.trim();
  const rows: PreviewRow[] = !isCreate && analytes.length
    ? analytes.slice(0, 8).map((a) => ({ name: a['print_name'] || a['name'], value: '—', unit: a['current_version']?.['unit_code'] ?? '', range: '—' }))
    : [{ name: title || 'Test name', value: '12.5', unit: '', range: '—' }];

  const form = (
    <form ref={formRef} noValidate className="catalog-dense-form" onSubmit={(e) => void submit(e)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's')) { e.preventDefault(); formRef.current?.requestSubmit(); } }}>
      {fail ? <FailBanner fail={fail} /> : null}
      {off ? <p className="lims-description">Requires permission catalog.test.manage to change this test.</p> : null}
      <GridSection title="Basics" columns={6}>
        <TextField label="Code" name="code" maxLength={32} isRequired={isCreate} isDisabled={!isCreate || off} isReadOnly={!isCreate} value={s['code']!} onChange={set('code')} {...err('code')} />
        <TextField label="Name" name="name" maxLength={200} isRequired isDisabled={off} value={s['name']!} onChange={set('name')} {...err('name')} />
        <TextField label="Display name" name="display_name" maxLength={300} isDisabled={off} value={displayName} onChange={(x) => { setDnTouched(true); set('display_name')(x); }} {...err('display_name')} />
        <TextField label="Short name" name="short_name" maxLength={60} isDisabled={off} value={s['short_name']!} onChange={set('short_name')} {...err('short_name')} />
        <MiniSelect label="Department" isRequired isDisabled={off} value={s['department_id']!} onChange={set('department_id')} options={opt(departments, test?.['department_id'])} error={errors['department_id']} />
        <MiniSelect label="Category" isDisabled={off} value={s['category_id'] || NONE} onChange={(x) => set('category_id')(x === NONE ? '' : x)} options={[{ value: NONE, label: 'No category' }, ...cats.map((c) => ({ value: c.id, label: c.name }))]} error={errors['category_id']} />
        <MiniSelect label="Workflow type" isRequired isDisabled={off || hasPublishedAnalyteVersion} value={s['workflow_type']!} onChange={set('workflow_type')} options={WORKFLOWS} error={errors['workflow_type']} />
        <MiniSelect label="Specimen type" isRequired isDisabled={off} value={s['specimen']!} onChange={set('specimen')} options={[{ value: NONE, label: 'None (uses existing material)' }, ...opt(specimenTypes, s['specimen'])]} error={errors['specimen']} />
        <div onKeyDown={noEnter}><TextField label="Tags" name="tags" maxLength={1400} description="Comma separated" isDisabled={off} value={s['tags']!} onChange={set('tags')} {...err('tags')} /></div>
        <TextField label="Barcode text" name="barcode_text" maxLength={64} isDisabled={off} value={s['barcode_text']!} onChange={set('barcode_text')} {...err('barcode_text')} />
        <TextField label="Loyalty points" name="loyalty_points" maxLength={8} inputMode="numeric" isDisabled={off} value={s['loyalty_points']!} onChange={set('loyalty_points')} {...err('loyalty_points')} />
        <TextField label="Display order" name="display_order" maxLength={5} inputMode="numeric" isDisabled={off} value={s['display_order']!} onChange={set('display_order')} {...err('display_order')} />
        <TextField label="Description" name="description" maxLength={2000} isDisabled={off} value={s['description']!} onChange={set('description')} {...err('description')} />
        <TextField label="Font" name="font" maxLength={60} isDisabled={off} value={s['font']!} onChange={set('font')} {...err('font')} />
      </GridSection>
      <GridSection title="Report" columns={6}>
        <MiniSelect label="Report type" isDisabled={off} value={s['report_type'] || NONE} onChange={(x) => set('report_type')(x === NONE ? '' : x)} options={[{ value: NONE, label: 'Default' }, ...REPORT_TYPES]} error={errors['report_type']} />
        <MiniSelect label="Processing type" isDisabled={off} value={s['processing_type'] || NONE} onChange={(x) => set('processing_type')(x === NONE ? '' : x)} options={[{ value: NONE, label: 'Default' }, ...PROCESSING]} error={errors['processing_type']} />
        <TextField label="Template" name="template_ref" maxLength={120} isDisabled={off} value={s['template_ref']!} onChange={set('template_ref')} {...err('template_ref')} />
        <TextField label="Outsource name" name="outsource_name" maxLength={200} isDisabled={off} value={s['outsource_name']!} onChange={set('outsource_name')} {...err('outsource_name')} />
        <div onKeyDown={noEnter}><TextField label="NABL processing centres" name="nabl_processing_centres" maxLength={4100} description="Comma separated" isDisabled={off} value={s['nabl_processing_centres']!} onChange={set('nabl_processing_centres')} {...err('nabl_processing_centres')} /></div>
        <TextField label="Report order" name="report_order" maxLength={5} inputMode="numeric" isDisabled={off} value={s['report_order']!} onChange={set('report_order')} {...err('report_order')} />
      </GridSection>
      <GridSection title="Flags" columns={6}>
        {FLAGS.map(([k, label]) => <Check key={k} label={label} isDisabled={off} checked={!!flags[k]} onChange={(on) => setFlags((f) => ({ ...f, [k]: on }))} />)}
        {isCreate ? null : <Check label="Active" isDisabled={off} checked={!!flags['is_active']} onChange={(on) => setFlags((f) => ({ ...f, is_active: on }))} />}
      </GridSection>
      <GridSection title="Turnaround" columns={6} note="(all values in minutes)">
        {STAGES.map(([k, label]) => (
          <TextField key={k} label={label} name={`stage_${k}`} maxLength={6} inputMode="numeric" isDisabled={off} value={stages[k]!} onChange={(x) => { setStages((o) => ({ ...o, [k]: x })); setErrors(({ [`stage.${k}`]: _d, ...rest }) => rest); }} {...err(`stage.${k}`)} />
        ))}
        <TextField label="Alert before expiry" name="alert_before_expiry_minutes" maxLength={7} inputMode="numeric" isDisabled={off} value={s['alert_before_expiry_minutes']!} onChange={set('alert_before_expiry_minutes')} {...err('alert_before_expiry_minutes')} />
      </GridSection>
      <div className="lims-inline catalog-gap-2">
        {canEdit ? <Button type="submit" variant="primary" shortcut="Ctrl+S">{isCreate ? 'Create test' : 'Save'}</Button> : null}
        {canEdit && !isCreate && test ? <Button onPress={() => router.push(`/catalog/tests?new=1&copy=${String(test['id'])}`)}>Copy test</Button> : null}
        {isCreate ? <Button variant="ghost" onPress={() => onClose?.()}>Cancel</Button> : null}
      </div>
    </form>
  );

  const body = (
    <div className="catalog-form-with-preview" data-layout="form-with-preview">
      {form}
      <ReportPreview {...(!isCreate && analytes.length ? { title } : {})} rows={rows} />
    </div>
  );
  if (!isCreate) return body;
  return (
    <Drawer title="New test" isOpen onClose={() => onClose?.()} width="lg">
      {body}
    </Drawer>
  );
}
