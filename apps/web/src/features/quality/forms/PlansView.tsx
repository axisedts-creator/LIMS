'use client';
// 04-UI-UX §2.6 Plans tab: QC plans (instrument + analyte, N controls per run, composition, n-x rule, windows) with new / edit (= new version) / activate / deactivate. LD-140: @lims/ui only.
// helpKey of this screen is set by SetupShell (quality.setup_plans). C7 / C3 pickers go through the BFF and degrade to id fields without their read permission.
import { useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { activatePlanAction, createPlanAction, deactivatePlanAction, newPlanVersionAction } from './actions';
import { FormDialog, FormMessage, InstrumentPicker, ReasonDialog, TestAnalytePicker, err, levelOptions, useSetupAction } from './fields';
import { SetupShell } from './SetupShell';
import type { Material, Picked, Plan } from './types';
import { MSG, N_VALUES, UUID, defaultMeanRule, meanRules, ruleSetText, validatePlanParams, type Errors } from './validate';

const num = (v: number | undefined) => (v === undefined ? {} : { value: v });
const NO_MAP_WARNING = 'This analyte has no code map for this instrument in Catalog; QC values will arrive unmapped until it is added.';
const POINTERS: Record<string, string> = {
  '/instrument_id': 'instrument', '/test_id': 'test', '/analyte_id': 'analyte', '/change_reason': 'reason', '/params/composition': 'composition', '/params/controls_per_run': 'n',
  '/params/mean_rule': 'mean_rule', '/params/run_window_minutes': 'run_window', '/params/qc_validity_hours': 'qc_validity', '/params/hold_lookback_hours': 'hold_lookback',
};

export function PlansView({ rows, materials, canManage, pickInstruments, pickTests }: { rows: Plan[]; materials: Material[]; canManage: boolean; pickInstruments: boolean; pickTests: boolean }) {
  const act = useSetupAction();
  const [dialog, setDialog] = useState<{ plan?: Plan } | undefined>();
  const [deactivating, setDeactivating] = useState<Plan>();
  const [warn, setWarn] = useState<string>();
  const [failedPlan, setFailedPlan] = useState<string>();
  const levels = new Map(materials.flatMap((m) => m.levels.map((l) => [l.id, l.display_name] as const)));

  const activate = async (p: Plan) => {
    setFailedPlan(p.id);
    await act.run(`activate|${p.id}|${p.version}`, (k) => activatePlanAction(p.id, p.version, k), { ok: 'Plan activated' });
  };

  const columns: ColumnDef<Plan>[] = [
    { id: 'instrument', header: 'Instrument', isRowHeader: true, cell: (p) => p.instrument_label ?? p.instrument_id },
    { id: 'analyte', header: 'Analyte', cell: (p) => p.analyte_code ?? p.analyte_id },
    { id: 'n', header: 'N', align: 'end', cell: (p) => String(p.params.controls_per_run) },
    { id: 'composition', header: 'Composition', cell: (p) => p.params.composition.map((c) => `${levels.get(c.level_id) ?? '…'} ×${c.count}`).join(', ') },
    { id: 'rule', header: 'Mean rule', cell: (p) => p.params.mean_rule },
    { id: 'status', header: 'Status', cell: (p) => <StatusChip kind="generic" status={p.status} label={p.status === 'active' ? 'Active' : 'Inactive'} tone={p.status === 'active' ? 'success' : 'neutral'} /> },
    { id: 'version', header: 'Version', align: 'end', cell: (p) => ` ${p.current_version_no} ` }, // padded: the cell text stays a separate word when cells are read as one line
    ...(canManage ? [{
      id: 'actions', header: 'Actions',
      cell: (p: Plan) => (
        <>
          <Button size="sm" variant="ghost" onPress={() => setDialog({ plan: p })}>Edit</Button>
          {p.status === 'active'
            ? <Button size="sm" variant="ghost" onPress={() => { act.reset(); setDeactivating(p); }}>Deactivate</Button>
            : <Button size="sm" variant="ghost" onPress={() => void activate(p)}>Activate</Button>}
        </>
      ),
    }] : []),
  ];

  return (
    <SetupShell active="plans" actions={canManage ? <Button variant="primary" onPress={() => { act.reset(); setDialog({}); }}>New plan</Button> : undefined}>
      {warn ? <Banner tone="warning" title={warn} /> : null}
      {!dialog && !deactivating && act.targetMissing ? (
        <Banner tone="warning" title={act.general ?? ''}>
          <a className="lims-btn lims-btn-secondary lims-btn-sm" href={`/quality/setup/targets?plan_id=${failedPlan ?? ''}`}>Open targets</a>
        </Banner>
      ) : !dialog && !deactivating && act.general ? <Banner tone="danger" title={act.general} /> : null}
      <DataTable<Plan> columns={columns} rows={rows} getRowId={(p) => p.id} density="compact" caption="QC plans" emptyState={{ title: 'No QC plans.' }} />
      {dialog ? (
        <PlanDialog plan={dialog.plan} materials={materials} pickInstruments={pickInstruments} pickTests={pickTests} onClose={() => setDialog(undefined)} onWarnings={(w) => setWarn(w.includes('instrument_code_unmapped') ? NO_MAP_WARNING : undefined)} />
      ) : null}
      {deactivating ? <DeactivateDialog plan={deactivating} onClose={() => setDeactivating(undefined)} /> : null}
    </SetupShell>
  );
}

function DeactivateDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const act = useSetupAction();
  return (
    <ReasonDialog
      title="Deactivate plan" submitLabel="Deactivate" general={act.general} onClose={onClose}
      onSubmit={async (reason) => { await act.run(`deactivate|${plan.id}|${plan.version}|${reason}`, (k) => deactivatePlanAction(plan.id, plan.version, reason, k), { ok: 'Plan deactivated', onOk: onClose }); }}
    />
  );
}

interface CompRow { key: number; level: string | undefined; count: number | undefined }

function PlanDialog({ plan, materials, pickInstruments, pickTests, onClose, onWarnings }: {
  plan: Plan | undefined; materials: Material[]; pickInstruments: boolean; pickTests: boolean; onClose: () => void; onWarnings: (w: string[]) => void;
}) {
  const act = useSetupAction();
  const p = plan?.params;
  const [instrument, setInstrument] = useState<Picked>();
  const [test, setTest] = useState<Picked>();
  const [analyte, setAnalyte] = useState<string>();
  const [n, setN] = useState(p?.controls_per_run ?? 2);
  const [rows, setRows] = useState<CompRow[]>(p ? p.composition.map((c, i) => ({ key: i + 1, level: c.level_id, count: c.count })) : [{ key: 1, level: undefined, count: 1 }, { key: 2, level: undefined, count: 1 }]);
  const [next, setNext] = useState(10);
  const [meanRule, setMeanRule] = useState(p?.mean_rule ?? defaultMeanRule(2));
  const [twoTwo, setTwoTwo] = useState(p?.two_two_s_across_runs ?? true);
  const [across, setAcross] = useState(p?.count_rules_across_materials ?? true);
  const [ignoreRejected, setIgnoreRejected] = useState(p?.exclude_rejected_runs_from_history ?? true);
  const [runWindow, setRunWindow] = useState<number | undefined>(p?.run_window_minutes ?? 30);
  const [validity, setValidity] = useState<number | undefined>(p?.qc_validity_hours ?? 24);
  const [lookback, setLookback] = useState<number | undefined>(p?.hold_lookback_hours ?? 24);
  const [reason, setReason] = useState('');
  const levels = levelOptions(materials);
  const patch = (key: number, x: Partial<CompRow>) => setRows((r) => r.map((y) => (y.key === key ? { ...y, ...x } : y)));

  const changeN = (v: string) => {
    const nn = Number(v);
    setN(nn);
    if (!meanRules(nn).includes(meanRule)) setMeanRule(defaultMeanRule(nn));
  };

  const submit = async () => {
    const e: Errors = {};
    if (!plan) {
      if (!instrument) e['instrument'] = MSG.required('Instrument');
      else if (!UUID.test(instrument.id)) e['instrument'] = MSG.uuid('Instrument ID');
      if (!test) e['test'] = MSG.required('Test');
      else if (!UUID.test(test.id)) e['test'] = MSG.uuid('Test ID');
      if (!analyte) e['analyte'] = MSG.required('Analyte');
      else if (!UUID.test(analyte)) e['analyte'] = MSG.uuid('Analyte ID');
    }
    for (const [k, v, label] of [['run_window', runWindow, 'Run window'], ['qc_validity', validity, 'QC valid for'], ['hold_lookback', lookback, 'Hold look-back']] as const) if (v === undefined) e[k] = MSG.required(label);
    Object.assign(e, validatePlanParams({ controls_per_run: n, composition: rows.map((r) => ({ level_id: r.level, count: r.count })), mean_rule: meanRule, run_window_minutes: runWindow, qc_validity_hours: validity, hold_lookback_hours: lookback }));
    act.setErrors(e);
    if (Object.keys(e).length) return;
    const params = {
      controls_per_run: n, composition: rows.map((r) => ({ level_id: r.level!, count: r.count! })), mean_rule: meanRule, two_two_s_across_runs: twoTwo, count_rules_across_materials: across,
      exclude_rejected_runs_from_history: ignoreRejected, run_window_minutes: runWindow!, qc_validity_hours: validity!, hold_lookback_hours: lookback!,
    };
    const hints = { duplicateText: 'A plan for this instrument and analyte already exists.', pointer: (x: string) => POINTERS[x] };
    if (plan) {
      const input = { params, change_reason: reason.trim() };
      await act.run(`version|${plan.id}|${plan.version}|${JSON.stringify(input)}`, (k) => newPlanVersionAction(plan.id, plan.version, input, k), { ok: 'New plan version saved', hints, onOk: onClose });
    } else {
      const input = { instrument_id: instrument!.id, test_id: test!.id, analyte_id: analyte!, params };
      await act.run(JSON.stringify(input), (k) => createPlanAction(input, k), { ok: 'Plan created', hints, onOk: (d) => { onWarnings(d.warnings); onClose(); } });
    }
  };

  return (
    <FormDialog title={plan ? 'Edit plan' : 'New plan'} size="lg" submitLabel={plan ? 'Save' : 'Create'} onClose={onClose} onSubmit={submit} general={act.general}>
      {plan ? (
        <DescriptionList items={[{ term: 'Instrument', value: plan.instrument_label ?? plan.instrument_id }, { term: 'Analyte', value: `${plan.analyte_code ?? plan.analyte_id}${plan.analyte_name ? ` — ${plan.analyte_name}` : ''}` }]} />
      ) : (
        <>
          <InstrumentPicker enabled={pickInstruments} value={instrument} onChange={setInstrument} error={act.errors['instrument']} />
          <TestAnalytePicker enabled={pickTests} test={test} onTest={setTest} analyte={analyte} onAnalyte={setAnalyte} testError={act.errors['test']} analyteError={act.errors['analyte']} />
        </>
      )}
      <RadioGroup<string> label="Controls per run (N)" name="n" orientation="horizontal" options={N_VALUES.map((v) => ({ value: v, label: v }))} value={String(n)} onChange={changeN} {...err(act.errors['n'])} />
      {rows.map((r) => (
        <div key={r.key}>
          <Select<string> label="Level" name={`level_${r.key}`} options={levels} {...(r.level ? { value: r.level } : {})} onChange={(v) => patch(r.key, { level: v })} />
          <IntegerField label="Count" name={`count_${r.key}`} min={1} max={4} {...num(r.count)} onChange={(v) => patch(r.key, { count: v })} />
          <Button size="sm" variant="ghost" isDisabled={rows.length <= 1} onPress={() => setRows((x) => x.filter((y) => y.key !== r.key))}>Remove level</Button>
        </div>
      ))}
      <Button size="sm" isDisabled={rows.length >= 4} onPress={() => { setRows((x) => [...x, { key: next, level: undefined, count: 1 }]); setNext(next + 1); }}>Add level</Button>
      <FormMessage text={act.errors['composition']} />
      <Select<string> label="n-x rule" name="mean_rule" options={meanRules(n).map((x) => ({ value: x, label: x }))} value={meanRule} onChange={setMeanRule} {...err(act.errors['mean_rule'])} />
      <Switch label="2-2s also across runs" isSelected={twoTwo} onChange={setTwoTwo} />
      <Switch label="Count rules across levels" isSelected={across} onChange={setAcross} />
      <Switch label="Ignore rejected runs in history" isSelected={ignoreRejected} onChange={setIgnoreRejected} />
      <IntegerField label="Run window (minutes)" name="run_window" min={5} max={240} {...num(runWindow)} onChange={setRunWindow} {...err(act.errors['run_window'])} />
      <IntegerField label="QC valid for (hours)" name="qc_validity" min={1} max={168} {...num(validity)} onChange={setValidity} {...err(act.errors['qc_validity'])} />
      <IntegerField label="Hold look-back (hours)" name="hold_lookback" min={1} max={168} {...num(lookback)} onChange={setLookback} {...err(act.errors['hold_lookback'])} />
      <p role="status" className="lims-description">{`Rules: ${ruleSetText(n, meanRule)}. Mode: as set in Admin › Tenant settings.`}</p>
      {plan ? <TextField label="Reason for change" name="change_reason" isRequired maxLength={500} value={reason} onChange={setReason} {...err(act.errors['reason'])} /> : null}
    </FormDialog>
  );
}
