'use client';
// SCR-07 analyte editor (04-UI-UX §4): create (initial draft version) or view/edit versions of an analyte.
// Display fields + clinical definition; published versions are read-only (edit = new draft, AC-03.2); publish goes through PublishDialog.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createAnalyteAction, createAnalyteVersionDraftAction, updateAnalyteVersionDraftAction } from '../server/actions';
import type { AnalyteRow, AnalyteVersion } from '../server/types';
import { FormulaPanel } from './FormulaPanel';
import { PublishDialog } from './PublishDialog';
import { errAt, fmtDateTime, FailBanner, MirrorInvalid, newKey, PERM, STATUS_LABEL, type Fail } from './shared';

const CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const CODE_HINT = '^[A-Z][A-Z0-9_]{0,31}$';
const RESULT_TYPES = [
  { value: 'numeric', label: 'Numeric' },
  { value: 'ordinal', label: 'Ordinal' },
  { value: 'coded', label: 'Coded' },
  { value: 'text', label: 'Text' },
  { value: 'narrative', label: 'Narrative' },
] as const;
const NEEDS_VALUE_SET = new Set(['ordinal', 'coded']);
type Draft = { id: string; version_no: number; version: number };

export function AnalyteEditor({ testId, analyte, versions, units, methods, valueSets, subheadings, rangeDraft, criticalDraft, permissions }: {
  testId: string;
  analyte: AnalyteRow | null;
  versions: readonly AnalyteVersion[];
  units: readonly { code: string; display: string }[];
  methods: readonly { id: string; name: string; is_active: boolean }[];
  valueSets: readonly { code: string; display: string; is_ordered: boolean }[];
  subheadings: readonly string[];
  rangeDraft?: Draft | undefined;
  criticalDraft?: Draft | undefined;
  permissions: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const canManage = permissions.includes(PERM.manage);
  const isCreate = analyte === null;

  const draft = versions.find((v) => v.status === 'draft');
  const published = versions.find((v) => v.status === 'published');
  const [selected, setSelected] = useState(() => String((published ?? versions[0])?.version_no ?? ''));
  const [editing, setEditing] = useState(false);
  const shown = versions.find((v) => String(v.version_no) === selected);
  const canEdit = canManage && (isCreate || (editing && shown?.status === 'draft'));

  // display fields (create only; existing analytes edit them via the Analytes tab)
  const [code, setCode] = useState(analyte?.code ?? '');
  const [name, setName] = useState(analyte?.name ?? '');
  const [printName, setPrintName] = useState(analyte?.print_name ?? '');
  const [subheading, setSubheading] = useState(analyte?.report_subheading ?? '');
  // clinical definition (per version)
  const [resultType, setResultType] = useState(shown?.result_type ?? 'numeric');
  const [unit, setUnit] = useState(shown?.unit_code ?? '');
  const [decimals, setDecimals] = useState<number | undefined>(shown?.decimals);
  const [method, setMethod] = useState(shown?.method_id ?? '');
  const [valueSet, setValueSet] = useState(shown?.value_set_code ?? '');
  const [formula, setFormula] = useState(shown?.formula_expression ?? '');
  const [fail, setFail] = useState<Fail>();
  const [local, setLocal] = useState<{ code?: string }>({});
  const [publishing, setPublishing] = useState(false);

  const load = (v: AnalyteVersion | undefined) => {
    setResultType(v?.result_type ?? 'numeric');
    setUnit(v?.unit_code ?? '');
    setDecimals(v?.decimals);
    setMethod(v?.method_id ?? '');
    setValueSet(v?.value_set_code ?? '');
    setFormula(v?.formula_expression ?? '');
    setFail(undefined);
  };
  const choose = (no: string) => {
    setSelected(no);
    setEditing(false);
    load(versions.find((v) => String(v.version_no) === no));
  };

  const numeric = resultType === 'numeric';
  const needsSet = NEEDS_VALUE_SET.has(resultType);
  const off = !canEdit;

  /** Clinical fields for the API; only what applies to the chosen result type. */
  const definition = () => ({
    result_type: resultType,
    ...(numeric && unit ? { unit_code: unit } : {}),
    ...(numeric && decimals !== undefined ? { decimals } : {}),
    ...(method && resultType !== 'narrative' ? { method_id: method } : {}),
    ...(needsSet && valueSet ? { value_set_code: valueSet } : {}),
    ...(numeric && formula.trim() ? { formula_expression: formula } : {}),
  });

  const submit = async () => {
    if (isCreate) {
      if (!CODE_RE.test(code)) return setLocal({ code: `Code must match ${CODE_HINT}` });
      setLocal({});
      const r = await createAnalyteAction(testId, { code, name, ...(printName ? { print_name: printName } : {}), ...(subheading ? { report_subheading: subheading } : {}), initial_version: definition() }, newKey());
      if (r.ok) {
        setFail(undefined);
        toast.show({ tone: 'success', title: `Analyte ${r.data.code} created.` });
        router.push(`/catalog/tests/${testId}?analyte=${r.data.id}`);
      } else setFail(r);
      return;
    }
    if (!shown || shown.status !== 'draft') return;
    const def = definition();
    const was: Record<string, unknown> = { unit_code: shown.unit_code, decimals: shown.decimals, method_id: shown.method_id, value_set_code: shown.value_set_code, formula_expression: shown.formula_expression };
    const unset = Object.keys(was).filter((k) => was[k] !== undefined && !(k in def));
    const r = await updateAnalyteVersionDraftAction(shown.id, shown.version, { ...def, ...(unset.length ? { unset } : {}) });
    if (r.ok) {
      setFail(undefined);
      toast.show({ tone: 'success', title: 'Draft saved.' });
      router.refresh();
    } else setFail(r);
  };

  const createVersion = async () => {
    if (!analyte) return;
    const r = await createAnalyteVersionDraftAction(analyte.id, newKey());
    if (r.ok) {
      setFail(undefined);
      toast.show({ tone: 'success', title: `Draft version ${r.data.version_no} created.` });
      router.refresh();
    } else setFail(r);
  };

  const codeError = local.code ?? errAt(fail, '/code') ?? (fail?.code === 'catalog.code_duplicate' ? 'This code is already used in this test.' : undefined);
  const field = (...p: string[]) => { const m = errAt(fail, ...p); return m ? { error: m } : {}; };
  const unitOrMethodChanged = !!draft && !!published && (draft.unit_code !== published.unit_code || draft.method_id !== published.method_id);
  const hasDraft = !!draft || !!analyte?.has_draft;

  return (
    <div className="lims-stack catalog-gap-3">
      {!isCreate && shown ? (
        <>
          <p>{`Version ${shown.version_no} · ${STATUS_LABEL[shown.status] ?? shown.status}${shown.effective_from ? ` · effective ${fmtDateTime(shown.effective_from)}` : ''}`}</p>
          <Select label="Version" name="version" value={selected} onChange={choose} options={versions.map((v) => ({ value: String(v.version_no), label: `Version ${v.version_no} · ${STATUS_LABEL[v.status] ?? v.status}` }))} />
        </>
      ) : null}
      {fail && !(fail.status === 400 && fail.errors?.length) ? (
        <FailBanner
          fail={fail}
          extra={fail.code === 'catalog.version_in_use' && canManage ? <div><Button onPress={() => void createVersion()}>Create new version</Button></div> : undefined}
        />
      ) : null}
      <Form onSubmit={submit} errorSummary={false}>
        <MirrorInvalid>
        {isCreate ? (
          <>
            <TextField label="Code" name="code" maxLength={32} isRequired value={code} description={CODE_HINT} onChange={(v) => { setCode(v.toUpperCase()); setLocal({}); }} {...(codeError ? { error: codeError } : {})} />
            <TextField label="Name" name="name" maxLength={120} isRequired value={name} onChange={setName} {...field('/name')} />
            <TextField label="Print name" name="print_name" maxLength={120} value={printName} onChange={setPrintName} {...field('/print_name')} />
            <TextField label="Sub-heading" name="report_subheading" maxLength={80} value={subheading} onChange={setSubheading} {...(subheadings.length ? { description: `Existing: ${subheadings.join(', ')}` } : {})} {...field('/report_subheading')} />
          </>
        ) : null}
        <Select label="Result type" name="result_type" isDisabled={off} value={resultType as (typeof RESULT_TYPES)[number]['value']} onChange={setResultType} options={RESULT_TYPES} {...field('/initial_version/result_type', '/result_type')} />
        {numeric ? (
          <>
            <Select label="Unit" name="unit_code" isDisabled={off} {...(unit ? { value: unit } : {})} onChange={setUnit} options={units.map((u) => ({ value: u.code, label: u.display }))} {...field('/initial_version/unit_code', '/unit_code')} />
            <IntegerField label="Decimals" name="decimals" min={0} max={6} isRequired isDisabled={off} {...(decimals !== undefined ? { value: decimals } : {})} onChange={setDecimals} {...field('/initial_version/decimals', '/decimals')} />
          </>
        ) : null}
        {resultType !== 'narrative' ? (
          <Select label="Method" name="method_id" isDisabled={off} {...(method ? { value: method } : {})} onChange={setMethod} options={methods.filter((m) => m.is_active || m.id === method).map((m) => ({ value: m.id, label: m.name }))} {...field('/initial_version/method_id', '/method_id')} />
        ) : null}
        {needsSet ? (
          <Select label="Value set" name="value_set_code" isRequired isDisabled={off} {...(valueSet ? { value: valueSet } : {})} onChange={setValueSet} options={valueSets.map((s) => ({ value: s.code, label: s.display }))} {...field('/initial_version/value_set_code', '/value_set_code')} />
        ) : null}
        {numeric ? (
          <FormulaPanel analyteId={analyte?.id} value={formula} onChange={setFormula} isReadOnly={off} error={errAt(fail, '/initial_version/formula_expression', '/formula_expression')} />
        ) : null}
        </MirrorInvalid>
        <div className="lims-inline catalog-gap-2">
          {canEdit ? <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Save</Button> : null}
          {canEdit && !isCreate ? <Button variant="ghost" onPress={() => choose(selected)}>Cancel</Button> : null}
        </div>
      </Form>
      {!isCreate && canManage ? (
        <div className="lims-inline catalog-gap-2">
          {!hasDraft ? <Button onPress={() => void createVersion()}>Create new version</Button> : null}
          {hasDraft && !editing && draft ? <Button onPress={() => { setSelected(String(draft.version_no)); setEditing(true); load(draft); }}>Edit draft</Button> : null}
          {editing && shown?.status === 'draft' ? <Button variant="primary" onPress={() => setPublishing(true)}>Publish…</Button> : null}
        </div>
      ) : null}
      {!isCreate && editing && shown?.status === 'draft' && analyte ? (
        <PublishDialog
          analyte={{ id: analyte.id, code: analyte.code, name: analyte.name }}
          version={{ id: shown.id, version_no: shown.version_no, version: shown.version }}
          rangeDraft={rangeDraft}
          criticalDraft={criticalDraft}
          unitOrMethodChanged={unitOrMethodChanged}
          permissions={permissions}
          isOpen={publishing}
          onClose={() => setPublishing(false)}
        />
      ) : null}
    </div>
  );
}
