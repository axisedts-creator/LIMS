'use client';
// 04-UI-UX §2.8 version editor and lifecycle: draft (rules, #39, #40, #45), simulating (#41, #43), stopped (copy, #37), active (#44). LD-140: @lims/ui only,
// ONE primary button per state, every status shows tone, icon and word. Every write survives 403 auth.mfa_required (AC-12.3) with its input intact.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { activateAction, createVersionAction, retireAction, transitionAction } from '../_lib/actions';
import { DASH, OVERVIEW_HREF, limitsText, statusOf, versionHref } from '../_lib/format';
import type { Report, Rule, Settings, Version } from '../_lib/types';
import { ReportView } from './ReportView';
import { RuleDrawer } from './RuleDrawer';
import { NoticeBanner, useWrite } from './shared';

type Iso = DateTextProps['value'];
type Open = 'start' | 'stop' | 'discard' | 'activate' | 'retire' | null;
const FIXED_RULES = "Never auto-verified, whatever the rules: critical results, delta-check failures, results without an instrument (manual or calculated), results while QC is out of control or missing. Auto-verification replaces only the technologist's first verification; a pathologist always approves.";

const onOff = (on: boolean) => <StatusChip kind="generic" status={on ? 'on' : 'off'} label={on ? 'On' : 'Off'} tone={on ? 'success' : 'neutral'} />;
type RuleRow = Rule & { _i: number }; // _i = position in the definition (the drawer edits by index)
const ruleColumns = (canEdit: boolean, edit: (i: number) => void): ColumnDef<RuleRow>[] => [
  { id: 'key', header: 'Key', isRowHeader: true, cell: (r) => r.key },
  { id: 'test', header: 'Test', cell: (r) => <IdText value={r.test_id} /> },
  { id: 'analyte', header: 'Analyte', cell: (r) => <IdText value={r.analyte_id} /> },
  { id: 'instrument', header: 'Instrument', cell: (r) => (r.instrument_id ? <IdText value={r.instrument_id} /> : 'Any instrument') },
  { id: 'enabled', header: 'Enabled', cell: (r) => (r.enabled ? onOff(true) : <>{onOff(false)} Never auto-verify this analyte on this instrument</>) },
  { id: 'limits', header: 'Limits', cell: (r) => limitsText(r.limits) },
  { id: 'flags', header: 'Flags', cell: (r) => [...(r.allowed_range_flags ?? []), ...(r.qc_allow_warning ? ['QC warning allowed'] : []), ...(r.instrument_flags_allowed ?? [])].join(', ') || DASH },
  ...(canEdit ? [{ id: 'actions', header: 'Actions', cell: (r: RuleRow) => <Button size="sm" onPress={() => edit(r._i)}>Edit<VisuallyHidden> {r.key}</VisuallyHidden></Button> }] : []),
];

export function VersionView({ version, report, settings, canManage }: { version: Version; report: Report | undefined; settings: Settings | undefined; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const copy = useWrite();
  const [open, setOpen] = useState<Open>(null);
  const [drawer, setDrawer] = useState<number | null>(null); // rule index being edited, -1 = a new rule
  const status = version.status;
  const st = statusOf(status);
  const rules = version.definition.rules;
  const canEdit = canManage && status === 'draft';
  const showReport = status === 'simulating' || status === 'stopped';

  // Activation minimums (AC-11.2). When #51 or the report is unavailable nothing is guessed here: the API enforces them and answers quality.simulation_incomplete.
  const needDays = settings && report ? Math.max(0, settings.sim_min_days - report.days_running) : 0;
  const needDecisions = settings && report ? Math.max(0, settings.sim_min_decisions - report.decisions) : 0;
  const hint = needDays || needDecisions
    ? `Needs ${[needDays ? `${needDays} more ${needDays === 1 ? 'day' : 'days'}` : '', needDecisions ? `${needDecisions} more ${needDecisions === 1 ? 'decision' : 'decisions'}` : ''].filter(Boolean).join(' / ')}`
    : '';

  const rows: RuleRow[] = rules.map((r, i) => ({ ...r, _i: i }));
  const columns = ruleColumns(canEdit, setDrawer);
  const copyToDraft = () => copy.run('create', version.id, (key) => createVersionAction(version.id, key), (v) => router.push(versionHref(v.id)));

  return (
    <>
      <PageHeader
        title={`Version ${version.version_no}`}
        helpKey="quality.autoverify_version"
        status={<StatusChip kind="generic" status={status} label={st.label} tone={st.tone} />}
        actions={canManage ? (
          <>
            {status === 'draft' ? (
              <>
                <Button onPress={() => setDrawer(-1)}>Add rule</Button>
                <Button variant="ghost" onPress={() => setOpen('discard')}>Discard draft</Button>
                <Button variant="primary" onPress={() => setOpen('start')}>Start simulation</Button>
              </>
            ) : null}
            {status === 'simulating' ? (
              <>
                <Button onPress={() => setOpen('stop')}>Stop simulation</Button>
                <Button variant="primary" isDisabled={!!hint} onPress={() => setOpen('activate')}>Activate</Button>
              </>
            ) : null}
            {status === 'stopped' ? <Button variant="primary" isLoading={copy.pending} onPress={() => void copyToDraft()}>Copy to new draft</Button> : null}
            {status === 'active' ? <Button onPress={() => setOpen('retire')}>Retire</Button> : null}
          </>
        ) : null}
      />
      <NoticeBanner notice={copy.notice} onReload={() => router.refresh()} />
      {status === 'simulating' && canManage && hint ? <p className="lims-description">{hint}</p> : null}
      <DescriptionList columns={2} items={[
        { term: 'Created by', value: <>{version.created_by_display} · <DateText value={version.created_at as Iso} withTime /></> },
        ...(version.simulation_started_at ? [{ term: 'Simulation started', value: <DateText value={version.simulation_started_at as Iso} withTime /> }] : []),
        ...(version.simulation_stopped_at ? [{ term: 'Simulation stopped', value: <DateText value={version.simulation_stopped_at as Iso} withTime /> }] : []),
        ...(version.activated_at ? [{ term: 'Activated by', value: <>{version.activated_by_display ?? DASH} · <DateText value={version.activated_at as Iso} withTime /></> }] : []),
        ...(version.retired_at ? [{ term: 'Retired', value: <DateText value={version.retired_at as Iso} withTime /> }] : []),
      ]} />
      <Card title="Fixed rules"><p>{FIXED_RULES}</p></Card>
      <Card title="Rules">
        <DataTable<RuleRow>
          columns={columns} rows={rows} getRowId={(r) => String(r._i)} density="compact" caption="Rules"
          emptyState={{ title: 'No rules yet.', ...(canEdit ? { body: 'Use Add rule to write the first one.' } : {}) }}
        />
      </Card>
      {showReport ? <ReportView report={report} /> : null}

      {drawer !== null ? <RuleDrawer rules={rules} index={drawer} versionId={version.id} version={version.version} onClose={() => setDrawer(null)} /> : null}
      {open === 'start' || open === 'stop' || open === 'discard' ? <TransitionDialog step={open} version={version} onClose={() => setOpen(null)} /> : null}
      {open === 'activate' ? <ActivateDialog version={version} onClose={() => setOpen(null)} onDone={() => { toast.show({ tone: 'success', title: 'Version activated' }); setOpen(null); router.refresh(); }} /> : null}
      {open === 'retire' ? <RetireDialog version={version} onClose={() => setOpen(null)} onDone={() => { toast.show({ tone: 'success', title: 'Version retired' }); setOpen(null); router.refresh(); }} /> : null}
    </>
  );
}

const COPY = {
  start: { title: 'Start simulation', body: 'Start simulating this version? It is compared with real decisions without changing any result, and its rules can no longer be edited.', done: 'Simulation started' },
  stop: { title: 'Stop simulation', body: 'Stop this simulation? The version will be closed for good. To simulate again, copy it into a new draft.', done: 'Simulation stopped' },
  discard: { title: 'Discard draft', body: 'Discard this draft? It stays in the version list as discarded and cannot be edited again.', done: 'Draft discarded' },
} as const;

/** #40 start-simulation, #41 stop-simulation, #45 discard. */
function TransitionDialog({ step, version, onClose }: { step: keyof typeof COPY; version: Version; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const w = useWrite();
  const c = COPY[step];
  const go = () => w.run(step, step, (key) => transitionAction(step, version.id, version.version, key), () => {
    toast.show({ tone: 'success', title: c.done });
    onClose();
    if (step === 'discard') router.push(OVERVIEW_HREF);
    else router.refresh();
  });
  return (
    <ConfirmDialog
      title={c.title} isOpen confirmLabel={c.title} onCancel={onClose} tone={step === 'discard' ? 'danger' : 'default'}
      body={<><p>{c.body}</p><NoticeBanner notice={w.notice} onReload={() => router.refresh()} /></>}
      onConfirm={() => go()}
    />
  );
}

/** #43 activate: type ACTIVATE (maxLength 8); a different person than the creator must do it (AC-12.1); the API checks the minimums again (AC-11.2). */
function ActivateDialog({ version, onClose, onDone }: { version: Version; onClose: () => void; onDone: () => void }) {
  const router = useRouter();
  const w = useWrite();
  const [text, setText] = useState('');
  const ready = text === 'ACTIVATE';
  const go = () => (ready ? w.run('activate', text, (key) => activateAction(version.id, version.version, text, key), onDone) : undefined);
  return (
    <Dialog
      title="Activate version" isOpen onClose={onClose} size="md"
      footer={<>
        <Button variant="ghost" onPress={onClose}>Cancel</Button>
        <Button variant="primary" isDisabled={!ready} isLoading={w.pending} onPress={() => void go()}>Activate</Button>
      </>}
    >
      <NoticeBanner notice={w.notice} onReload={() => router.refresh()} />
      <p>Activation makes this version the live rule set for your lab. You can&apos;t activate a version you created.</p>
      <TextField label="Type ACTIVATE to confirm" name="confirmation_text" maxLength={8} value={text} onChange={setText} />
    </Dialog>
  );
}

/** #44 retire: reason 1..500. */
function RetireDialog({ version, onClose, onDone }: { version: Version; onClose: () => void; onDone: () => void }) {
  const router = useRouter();
  const w = useWrite();
  const [reason, setReason] = useState('');
  const text = reason.trim();
  const go = () => (text ? w.run('retire', text, (key) => retireAction(version.id, version.version, text, key), onDone) : undefined);
  return (
    <Dialog
      title="Retire version" isOpen onClose={onClose} size="md"
      footer={<>
        <Button variant="ghost" onPress={onClose}>Cancel</Button>
        <Button variant="primary" isDisabled={!text} isLoading={w.pending} onPress={() => void go()}>Retire</Button>
      </>}
    >
      <NoticeBanner notice={w.notice} onReload={() => router.refresh()} />
      <p>Retire this version? Auto-verification stops using its rules, and results are checked by hand again unless another version is activated.</p>
      <TextArea label="Reason" name="reason" maxLength={500} isRequired value={reason} onChange={setReason} />
    </Dialog>
  );
}
