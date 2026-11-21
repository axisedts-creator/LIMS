'use client';
// 04-UI-UX §2.3 QC run detail + actions #30-#33 (03-APP-FLOW §4). LD-140: @lims/ui only. Mutations go through server actions (token and If-Match stay server-side).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DateTimePicker, type DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { KeyboardShortcutsDialog } from '@lims/ui/components/KeyboardShortcutsDialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import { MODE, OUTCOME, RUN_STATUS, rulesText, z2 } from '../format';
import { acknowledgeRunAction, closeRunAction, correctiveActionAction, evaluateRunAction } from '../server/actions';
import type { ActionResult, CodeOption, RunDetail, RunObservation } from '../types';
import { useAttemptKey } from './Shared';

type Iso = DateTextProps['value'];
type Open = 'evaluate' | 'corrective' | 'close' | 'acknowledge' | 'help' | null;

/** Plain-language text for the API errors these actions can return (never the raw code). */
const FAIL: Record<string, string> = {
  'quality.qc_run_already_evaluated': 'This run has already been evaluated. Reload the page to see its result.',
  'quality.corrective_action_required': 'Record a corrective action first.',
  'quality.rerun_required': 'Run QC again and wait for an accepted run before closing.',
  'common.version_conflict': 'Someone else changed this run. Reload the page and try again.',
  'common.precondition_required': 'Reload the page and try again.',
  'common.validation_failed': 'Check the values and try again.',
  'auth.forbidden': 'You no longer have access to this action.',
};
const failText = (r: { code: string }) => FAIL[r.code] ?? 'The action did not complete. Try again.';

const KIND: Record<string, string> = { acknowledge: 'Acknowledged', evaluate_now: 'Evaluated now', close: 'Closed' };
const OBS_STATUS: Record<string, string> = { assigned: 'Assigned', excluded: 'Excluded' };
const SHORTCUTS = [{ id: 'page', title: 'This page', shortcuts: [
  { keys: 'E', description: 'Evaluate now' }, { keys: 'C', description: 'Record corrective action' }, { keys: 'A', description: 'Acknowledge' }, { keys: '?', description: 'Show keyboard shortcuts' }, { keys: 'Esc', description: 'Close a dialog' },
] }];
const DT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kathmandu' });
const dt = (iso: string) => DT.format(new Date(iso)).replace(/\b(am|pm)\b/, (m) => m.toUpperCase());

export function RunDetailView({ run, label, canReview, correctiveOptions }: { run: RunDetail; label?: { instrument: string; analyte: string } | undefined; canReview: boolean; correctiveOptions: CodeOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const [error, setError] = useState<string>();
  const [comment, setComment] = useState('');
  const key = useAttemptKey();

  const closed = run.status === 'closed';
  const can = {
    evaluate: canReview && run.status === 'collecting',
    corrective: canReview && run.outcome === 'rejected' && !closed,
    close: canReview && run.outcome === 'rejected' && !closed,
    acknowledge: canReview && run.outcome === 'accepted_warning' && !closed && !run.reviews.some((r) => r.kind === 'acknowledge'),
  };
  const show = (o: Open) => { setError(undefined); setComment(''); setOpen(o); };
  const done = (title: string) => { key.done(); setOpen(null); toast.show({ tone: 'success', title }); router.refresh(); };

  // Page shortcuts (04-UI-UX §2.3): E / C / A act only when the button is offered; ? lists them; Esc closes a confirm dialog (the kit blocks Esc there).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen((o) => (o === 'evaluate' || o === 'close' ? null : o)); return; }
      if (open || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'e' && can.evaluate) show('evaluate');
      else if (k === 'c' && can.corrective) show('corrective');
      else if (k === 'a' && can.acknowledge) show('acknowledge');
      else if (e.key === '?') show('help');
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const simple = async (r: Promise<ActionResult<unknown>>, ok: string) => {
    const res = await r;
    if (res.ok) done(ok);
    else setError(failText(res));
  };

  const obsColumns: ColumnDef<RunObservation>[] = [
    { id: 'level', header: 'Level', isRowHeader: true, cell: (o) => o.control_level_raw },
    { id: 'lot', header: 'Lot', cell: (o) => o.control_lot_raw },
    { id: 'at', header: 'Observed at', cell: (o) => (<><DateText value={o.observed_at as Iso} withTime />{o.observed_at_basis === 'server' ? ' (server time)' : ''}</>) },
    { id: 'value', header: 'Value', align: 'end', cell: (o) => `${o.value}${o.unit_code ? ` ${o.unit_code}` : ''}` },
    { id: 'z', header: 'z', align: 'end', cell: (o) => z2(o.z) },
    { id: 'rules', header: 'Rule hits', cell: (o) => rulesText(o.rule_hits) },
    { id: 'status', header: 'Status', cell: (o) => OBS_STATUS[o.status] ?? o.status },
  ];

  const outcome = run.outcome ? OUTCOME[run.outcome] : undefined;
  const state = RUN_STATUS[run.status];
  const where = label ? `${label.analyte} on ${label.instrument}` : 'this analyte on this instrument';
  const title = label ? `QC run · ${label.analyte} · ${label.instrument}` : 'QC run';
  const none = (t: string) => <p className="lims-description">{t}</p>;

  return (
    <>
      <PageHeader
        title={title}
        helpKey="quality.qc_run"
        status={<>{outcome ? <StatusChip kind="generic" status={run.outcome ?? ''} label={outcome.label} tone={outcome.tone} /> : null}{!outcome || run.status !== 'evaluated' ? <StatusChip kind="generic" status={run.status} label={state.label} tone={state.tone} /> : null}</>}
        actions={<>
          {can.evaluate ? <Button variant="primary" shortcut="E" onPress={() => show('evaluate')}>Evaluate now</Button> : null}
          {can.corrective ? <Button variant="primary" shortcut="C" onPress={() => show('corrective')}>Record corrective action</Button> : null}
          {can.close ? <Button onPress={() => show('close')}>Close run</Button> : null}
          {can.acknowledge ? <Button variant="primary" shortcut="A" onPress={() => show('acknowledge')}>Acknowledge</Button> : null}
        </>}
      />
      {run.outcome === 'rejected' && run.hold ? (
        <Banner tone="danger" title={`This run was rejected (${run.rules_violated.join(', ')}). Patient results for ${where} since ${dt(run.hold.hold_since)} were put on hold in Lab.`} />
      ) : null}
      <DescriptionList
        columns={2}
        items={[
          { term: 'Run time', value: <DateText value={run.run_at as Iso} withTime /> },
          { term: 'Plan version', value: String(run.plan_version_no) },
          { term: 'Controls per run (N)', value: String(run.controls_per_run) },
          { term: 'Mode', value: MODE[run.rule_mode] ?? run.rule_mode },
          { term: 'Complete', value: run.is_complete ? 'Yes' : 'No' },
          ...(run.evaluated_at ? [{ term: 'Evaluated at', value: <><DateText value={run.evaluated_at as Iso} withTime />{run.evaluated_by ? ` · ${run.evaluated_by}` : ''}</> }] : []),
          ...(run.hold ? [{ term: 'Hold since', value: <DateText value={run.hold.hold_since as Iso} withTime /> }] : []),
          ...(run.hold?.last_in_control_run_at ? [{ term: 'Last in-control run', value: <DateText value={run.hold.last_in_control_run_at as Iso} withTime /> }] : []),
        ]}
      />
      <Card title="Observations">
        <DataTable<RunObservation>
          columns={obsColumns} rows={run.observations} getRowId={(o) => o.id} density="compact" caption="Run observations"
          emptyState={{ title: 'No observations in this run yet.' }}
        />
      </Card>
      <Card title="Rule hits">
        {/* T0D-UIGUARD-1-QUALITY (LD-436 R7): no raw ul; the items keep list semantics. */}
        {run.rule_detail.length ? <div role="list">{run.rule_detail.map((r) => <div role="listitem" key={r.rule}>{`${r.rule} — ${r.observation_ids.length} observation${r.observation_ids.length === 1 ? '' : 's'}`}</div>)}</div> : none('No rule was violated.')}
      </Card>
      <Card title="Corrective actions">
        {run.corrective_actions.length
          ? <Timeline items={run.corrective_actions.map((c) => ({ at: c.performed_at, label: `${c.action_display} — ${c.description}`, actor: c.performed_by_display }))} />
          : none('No corrective action recorded.')}
      </Card>
      <Card title="Reviews">
        {run.reviews.length
          ? <Timeline items={run.reviews.map((r) => ({ at: r.created_at, label: `${KIND[r.kind] ?? r.kind}${r.comment ? `: ${r.comment}` : ''}`, actor: r.reviewed_by_display }))} />
          : none('No reviews yet.')}
      </Card>

      <ConfirmDialog
        title="Evaluate this run" isOpen={open === 'evaluate'} confirmLabel="Evaluate" onCancel={() => setOpen(null)}
        body={<>
          <p>{`Evaluate this run with ${run.observation_count} of ${run.controls_per_run} controls? It will be marked incomplete if no rule is violated.`}</p>
          <TextArea label="Comment (optional)" name="comment" maxLength={500} value={comment} onChange={setComment} />
          {error ? <p role="alert">{error}</p> : null}
        </>}
        onConfirm={() => simple(evaluateRunAction(run.id, run.version, comment, key.keyFor(`evaluate|${comment}`)), 'Run evaluated')}
      />
      <ConfirmDialog
        title="Close run" isOpen={open === 'close'} confirmLabel="Close run" onCancel={() => setOpen(null)}
        body={<>
          <p>Close this rejected run? Patient results held by this failure are not released automatically.</p>
          {error ? <p role="alert">{error}</p> : null}
        </>}
        onConfirm={() => simple(closeRunAction(run.id, run.version, key.keyFor('close')), 'Run closed. Patient results held by this failure stay on hold until released in Lab › Settings › QC holds.')}
      />
      {open === 'corrective' ? (
        <CorrectiveDialog run={run} options={correctiveOptions} error={error} onClose={() => setOpen(null)} onSubmit={(input) => simple(correctiveActionAction(run.id, input, key.keyFor(JSON.stringify(input))), 'Corrective action recorded')} />
      ) : null}
      <Dialog title="Acknowledge warning" isOpen={open === 'acknowledge'} onClose={() => setOpen(null)} size="sm">
        <Form onSubmit={() => simple(acknowledgeRunAction(run.id, run.version, comment, key.keyFor(`ack|${comment}`)), 'Warning acknowledged')}>
          <TextArea label="Comment" name="comment" maxLength={500} isRequired value={comment} onChange={setComment} />
          {error ? <p role="alert">{error}</p> : null}
          <Button variant="primary" type="submit" shortcut="Ctrl+Enter">Acknowledge</Button>
        </Form>
      </Dialog>
      <KeyboardShortcutsDialog isOpen={open === 'help'} onClose={() => setOpen(null)} groups={SHORTCUTS} />
    </>
  );
}

function CorrectiveDialog({ run, options, error, onClose, onSubmit }: {
  run: RunDetail; options: CodeOption[]; error: string | undefined; onClose: () => void; onSubmit: (v: { action_code: string; description: string; performed_at: string }) => Promise<void>;
}) {
  const [code, setCode] = useState<string>();
  const [description, setDescription] = useState('');
  const [at, setAt] = useState<DateTimePickerProps['value']>(() => new Date().toISOString() as DateTimePickerProps['value']);
  const [atError, setAtError] = useState<string>();
  const submit = async () => {
    const t = Date.parse(at ?? '');
    // 04-UI-UX §2.3: not before the run minus 24 h, not later than now plus 5 min
    if (Number.isNaN(t) || t < Date.parse(run.run_at) - 86_400_000 || t > Date.now() + 300_000) return setAtError('Choose a time between 24 hours before the run and now.');
    setAtError(undefined);
    await onSubmit({ action_code: code ?? '', description, performed_at: new Date(t).toISOString() });
  };
  return (
    <Dialog title="Record corrective action" isOpen onClose={onClose} size="md">
      <Form onSubmit={submit}>
        <CodedSelect label="Action" name="action_code" codedSet="quality.corrective_actions" isRequired options={options} {...(code ? { value: code } : {})} onChange={setCode} />
        <TextArea label="Description" name="description" maxLength={1000} isRequired value={description} onChange={setDescription} />
        <DateTimePicker label="Performed at" name="performed_at" isRequired {...(at ? { value: at } : {})} onChange={setAt} {...(atError ? { error: atError } : {})} />
        {error ? <p role="alert">{error}</p> : null}
        <Button variant="ghost" onPress={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" shortcut="Ctrl+Enter">Save</Button>
      </Form>
    </Dialog>
  );
}
