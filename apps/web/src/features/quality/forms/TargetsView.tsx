'use client';
// 04-UI-UX §2.6 Targets tab: the targets of one QC plan; new manual (manufacturer) target, "establish from data" wizard, activate / retire / discard. There is NO edit of mean or SD (AC-04.6).
// helpKey of this screen is set by SetupShell (quality.setup_targets). Mean and SD are decimal STRINGS end to end (02-TRD §7.6); the wizard preview is an estimate, the server computes the target. LD-140: @lims/ui only.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { activateTargetAction, createTargetAction, discardTargetAction, establishTargetAction, previewObservationsAction, retireTargetAction } from './actions';
import { FormDialog, FormMessage, ReasonDialog, err, lotOptions, useSetupAction } from './fields';
import { SetupShell } from './SetupShell';
import type { Material, Plan, PreviewPoint, Target } from './types';
import { DAY, endOf, startOf, stats, todayLocal, validatePeriod, validateTarget, MSG, type Errors } from './validate';

type Iso = DateTextProps['value'];
const STATUS: Record<string, { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  draft: { label: 'Draft', tone: 'info' }, active: { label: 'Active', tone: 'success' }, superseded: { label: 'Superseded', tone: 'neutral' }, retired: { label: 'Retired', tone: 'neutral' }, discarded: { label: 'Discarded', tone: 'neutral' },
};
const PT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kathmandu' });
const planName = (p: Plan) => `${p.analyte_code ?? p.analyte_id} · ${p.instrument_label ?? p.instrument_id}`;

export function TargetsView({ plan, plans, targets, materials, canManage }: { plan?: Plan | undefined; plans: Plan[]; targets: Target[]; materials: Material[]; canManage: boolean }) {
  return (
    <SetupShell active="targets">
      {plan ? <PlanTargets plan={plan} targets={targets} materials={materials} canManage={canManage} /> : <PlanPicker plans={plans} />}
    </SetupShell>
  );
}

function PlanPicker({ plans }: { plans: Plan[] }) {
  const router = useRouter();
  return (
    <>
      <Combobox<Plan>
        label="Plan" name="plan" getKey={(p) => p.id} renderOption={planName} renderValue={planName} onChange={(p) => { if (p) router.push(`/quality/setup/targets?plan_id=${p.id}`); }}
        loadOptions={async (q) => plans.filter((p) => planName(p).toLowerCase().includes(q.trim().toLowerCase()))}
      />
      <EmptyState title="Choose a plan to see its targets." />
    </>
  );
}

type Step = { kind: 'new' } | { kind: 'establish' } | { kind: 'activate' | 'discard'; t: Target } | { kind: 'retire'; t: Target };

function PlanTargets({ plan, targets, materials, canManage }: { plan: Plan; targets: Target[]; materials: Material[]; canManage: boolean }) {
  const act = useSetupAction();
  const [open, setOpen] = useState<Step>();
  const decimals = (plan.decimals ?? 0) + 2;
  const lots = new Map(materials.flatMap((m) => m.levels.flatMap((l) => (l.lots ?? []).map((x) => [x.id, { lot: x.lot_no, level: l.display_name }] as const))));
  const levelName = new Map(materials.flatMap((m) => m.levels.map((l) => [l.id, l.display_name] as const)));
  const ask = (s: Step) => { act.reset(); setOpen(s); };
  const done = () => setOpen(undefined);

  const columns: ColumnDef<Target>[] = [
    { id: 'level', header: 'Level', isRowHeader: true, cell: (t) => levelName.get(t.level_id) ?? lots.get(t.lot_id)?.level ?? '—' },
    { id: 'lot', header: 'Lot', cell: (t) => lots.get(t.lot_id)?.lot ?? '—' },
    { id: 'mean', header: 'Mean', align: 'end', cell: (t) => t.mean },
    { id: 'sd', header: 'SD', align: 'end', cell: (t) => t.sd },
    { id: 'cv', header: 'CV %', align: 'end', cell: (t) => t.cv_pct ?? '—' },
    { id: 'unit', header: 'Unit', cell: (t) => t.unit_code ?? plan.unit_code ?? '—' },
    { id: 'source', header: 'Source', cell: (t) => (t.source === 'established' ? `Established${t.basis ? ` (n = ${t.basis.n})` : ''}` : 'Manufacturer') },
    { id: 'status', header: 'Status', cell: (t) => <StatusChip kind="generic" status={t.status} label={STATUS[t.status]?.label ?? t.status} tone={STATUS[t.status]?.tone ?? 'neutral'} /> },
    {
      id: 'effective', header: 'Effective',
      cell: (t) => (t.effective_from ? <><DateText value={t.effective_from as Iso} />{t.effective_to ? <>{' – '}<DateText value={t.effective_to as Iso} /></> : null}</> : '—'),
    },
    ...(canManage ? [{
      id: 'actions', header: 'Actions',
      cell: (t: Target) => (
        <>
          {t.status === 'draft' ? <><Button size="sm" variant="ghost" onPress={() => ask({ kind: 'activate', t })}>Activate</Button><Button size="sm" variant="ghost" onPress={() => ask({ kind: 'discard', t })}>Discard</Button></> : null}
          {t.status === 'active' ? <Button size="sm" variant="ghost" onPress={() => ask({ kind: 'retire', t })}>Retire</Button> : null}
        </>
      ),
    }] : []),
  ];

  const confirm = open?.kind === 'activate' || open?.kind === 'discard' ? open : undefined;
  return (
    <>
      <DescriptionList columns={2} items={[{ term: 'Plan', value: planName(plan) }, { term: 'Unit', value: plan.unit_code ?? '—' }]} />
      {canManage ? <><Button variant="primary" onPress={() => ask({ kind: 'new' })}>New target</Button><Button onPress={() => ask({ kind: 'establish' })}>Establish from data</Button></> : null}
      <DataTable<Target> columns={columns} rows={targets} getRowId={(t) => t.id} density="compact" caption="QC targets" emptyState={{ title: 'No targets for this plan.' }} />
      {open?.kind === 'new' ? <NewTargetDialog plan={plan} materials={materials} decimals={decimals} onClose={done} /> : null}
      {open?.kind === 'establish' ? <EstablishDialog plan={plan} materials={materials} onClose={done} /> : null}
      {open?.kind === 'retire' ? (
        <ReasonDialog
          title="Retire target" submitLabel="Retire" general={act.general} onClose={done}
          onSubmit={async (reason) => { const t = open.t; await act.run(`retire|${t.id}|${t.version}|${reason}`, (k) => retireTargetAction(t.id, t.version, reason, k), { ok: 'Target retired', onOk: done }); }}
        />
      ) : null}
      <ConfirmDialog
        title={confirm?.kind === 'discard' ? 'Discard draft target' : 'Activate target'} isOpen={!!confirm} tone={confirm?.kind === 'discard' ? 'danger' : 'default'} confirmLabel={confirm?.kind === 'discard' ? 'Discard' : 'Activate'} onCancel={done}
        body={<><p>{confirm?.kind === 'discard' ? 'Discard this draft target? It cannot be used afterwards.' : 'Activate this target from now? The current target for this lot will be superseded.'}</p><FormMessage text={act.general} /></>}
        onConfirm={async () => {
          if (!confirm) return;
          const t = confirm.t;
          const run = confirm.kind === 'discard' ? discardTargetAction : activateTargetAction;
          await act.run(`${confirm.kind}|${t.id}|${t.version}`, (k) => run(t.id, t.version, k), { ok: confirm.kind === 'discard' ? 'Target discarded' : 'Target activated', onOk: done });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- new manual target (#21)
function NewTargetDialog({ plan, materials, decimals, onClose }: { plan: Plan; materials: Material[]; decimals: number; onClose: () => void }) {
  const act = useSetupAction();
  const [lot, setLot] = useState<string>();
  const [mean, setMean] = useState('');
  const [sd, setSd] = useState('');
  const [note, setNote] = useState('');
  const options = lotOptions(materials, new Set(plan.params.composition.map((c) => c.level_id)));

  const submit = async () => {
    const e = validateTarget({ lot_id: lot, mean, sd, note }, decimals);
    act.setErrors(e);
    if (Object.keys(e).length || !lot) return;
    // strings, never JS numbers; the source of a manual target is always the manufacturer
    const input = { plan_id: plan.id, lot_id: lot, mean, sd, ...(plan.unit_code ? { unit_code: plan.unit_code } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    await act.run(JSON.stringify(input), (k) => createTargetAction(input, k), {
      ok: 'Target saved as draft', onOk: onClose,
      hints: { expired: { field: 'lot', text: 'This lot has expired.' }, pointer: (p) => ({ '/lot_id': 'lot', '/mean': 'mean', '/sd': 'sd', '/note': 'note' } as Record<string, string>)[p] },
    });
  };
  return (
    <FormDialog title="New target" submitLabel="Save" onClose={onClose} onSubmit={submit} general={act.general}>
      <Select<string> label="Lot" name="lot" options={options} {...(lot ? { value: lot } : {})} onChange={setLot} {...err(act.errors['lot'])} />
      <TextField label="Mean" name="mean" isRequired maxLength={24} description={`Up to ${decimals} decimal places`} value={mean} onChange={setMean} {...err(act.errors['mean'])} />
      <TextField label="SD" name="sd" isRequired maxLength={24} description="Greater than zero" value={sd} onChange={setSd} {...err(act.errors['sd'])} />
      <TextField label="Unit" name="unit" isReadOnly maxLength={32} value={plan.unit_code ?? ''} />
      <DescriptionList items={[{ term: 'Source', value: 'Manufacturer' }]} />
      <TextArea label="Note" name="note" maxLength={500} value={note} onChange={setNote} {...err(act.errors['note'])} />
    </FormDialog>
  );
}

// ---------------------------------------------------------------- establish from data (#22): 1 lot + period, 2 preview with points to exclude, 3 confirm -> draft target
function EstablishDialog({ plan, materials, onClose }: { plan: Plan; materials: Material[]; onClose: () => void }) {
  const act = useSetupAction();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [lot, setLot] = useState<string>();
  const [from, setFrom] = useState<IsoDate | undefined>(() => todayLocal(Date.now() - 30 * DAY) as IsoDate);
  const [to, setTo] = useState<IsoDate | undefined>(() => todayLocal() as IsoDate);
  const [points, setPoints] = useState<PreviewPoint[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [local, setLocal] = useState<Errors>({});
  const [problem, setProblem] = useState<string>();
  const options = lotOptions(materials, new Set(plan.params.composition.map((c) => c.level_id)));
  const dec = (plan.decimals ?? 0) + 2;
  const used = points.filter((p) => !off.has(p.id));
  const s = stats(used.map((p) => Number(p.value)));
  const fix = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(dec));

  const toPreview = async () => {
    const e: Errors = { ...validatePeriod(from, to) };
    if (!lot) e['lot'] = MSG.required('Lot');
    setLocal(e);
    if (Object.keys(e).length || loading || !lot) return;
    setLoading(true);
    setProblem(undefined);
    try {
      const r = await previewObservationsAction({ plan_id: plan.id, lot_id: lot, observed_at_from: startOf(from!), observed_at_to: endOf(to!) });
      if (!r.ok) { setProblem(r.status === 403 ? "You don't have permission to read these values." : 'The values could not be read. Try again.'); return; }
      setPoints(r.data.points);
      setTruncated(r.data.truncated);
      setOff(new Set());
      setStep(2);
    } finally {
      setLoading(false);
    }
  };

  const establish = async () => {
    if (!lot || !from || !to) return;
    const unticked = points.filter((p) => off.has(p.id)).map((p) => p.id);
    const kept = used.map((p) => p.id);
    const input = {
      plan_id: plan.id, lot_id: lot, observed_at_from: startOf(from), observed_at_to: endOf(to),
      ...(unticked.length === 0 ? {} : unticked.length <= kept.length ? { exclude_observation_ids: unticked } : { include_observation_ids: kept }),
    };
    await act.run(JSON.stringify(input), (k) => establishTargetAction(input, k), { ok: 'Target established as draft', onOk: onClose });
  };

  const footer = (
    <>
      <Button variant="ghost" onPress={onClose}>Cancel</Button>
      {step > 1 ? <Button onPress={() => { act.reset(); setStep((step - 1) as 1 | 2); }}>Back</Button> : null}
      {step === 1 ? <Button variant="primary" isLoading={loading} onPress={() => void toPreview()}>Next</Button> : null}
      {step === 2 ? <Button variant="primary" isDisabled={used.length === 0 || truncated} onPress={() => setStep(3)}>Next</Button> : null}
      {step === 3 ? <Button variant="primary" onPress={() => void establish()}>Establish</Button> : null}
    </>
  );

  return (
    <Dialog title="Establish from data" isOpen onClose={onClose} size="lg" footer={footer}>
      {step === 1 ? (
        <>
          <Select<string> label="Lot" name="lot" options={options} {...(lot ? { value: lot } : {})} onChange={setLot} {...err(local['lot'])} />
          <DatePicker label="From" name="from" {...(from ? { value: from } : {})} onChange={setFrom} {...err(local['from'])} />
          <DatePicker label="To" name="to" {...(to ? { value: to } : {})} onChange={setTo} {...err(local['to'])} />
          <FormMessage text={problem} />
        </>
      ) : null}
      {step === 2 ? (
        <>
          {points.length === 0 ? <p role="status">No accepted observations for this lot in this period.</p> : (
            <>
              <DescriptionList columns={2} items={[{ term: 'n', value: String(s.n) }, { term: 'Mean', value: fix(s.mean) }, { term: 'SD (sample)', value: fix(s.sd) }, { term: 'CV %', value: s.cv === undefined ? '—' : s.cv.toFixed(2) }]} />
              {truncated ? <FormMessage text="Too many values for a preview. Choose a shorter period." /> : null}
              <ul>
                {points.map((p) => (
                  <li key={p.id}>
                    <Checkbox label={`${PT.format(new Date(p.observed_at))} · ${p.value}`} isSelected={!off.has(p.id)} onChange={(on) => setOff((o) => { const x = new Set(o); if (on) x.delete(p.id); else x.add(p.id); return x; })} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : null}
      {step === 3 ? (
        <>
          <p>{`A draft target will be created from ${used.length} values (mean ${fix(s.mean)}, SD ${fix(s.sd)}). Activate it afterwards to use it.`}</p>
          <FormMessage text={act.general} />
        </>
      ) : null}
    </Dialog>
  );
}
