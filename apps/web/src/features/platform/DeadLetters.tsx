'use client';
// PL-6 Dead letters (US-E5; 04-UI-UX §7): filters (URL ↔ listDeadLetters params), table, detail with Replay / Discard.
// The API never returns the job's arguments (08 A8.5); nothing here asks for or renders them.
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { useToast } from '@lims/ui/components/Toast';
import { resolveDeadLetterAction } from './actions';
import { DEAD_LETTER_STATES, type DeadLetter } from './shared';
import { Alert, CheckboxInput, SelectInput, TextAreaInput, TextInput, fmtDateTime, useProblemDialogs, useSingleFlight } from './ui';

type TenantRef = { tenant_id: string; code: string };
export interface DeadLetterFilter { state: string; platform_rows: boolean; tenant_id: string; task_identifier: string; dead_at_from: string; dead_at_to: string }
const STATE_LABEL: Record<string, string> = { open: 'Open', replayed: 'Replayed', discarded: 'Discarded' };

export function DeadLetterFilters({ initial, tenants }: { initial: DeadLetterFilter; tenants: readonly TenantRef[] }) {
  const router = useRouter();
  const [f, setF] = useState(initial);
  const set = <K extends keyof DeadLetterFilter>(k: K) => (v: DeadLetterFilter[K]) => setF((p) => ({ ...p, [k]: v }));
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const q = new URLSearchParams();
    q.set('state', f.state);
    if (f.platform_rows) q.set('platform_rows', 'true');
    else if (f.tenant_id) q.set('tenant_id', f.tenant_id);
    if (f.task_identifier.trim()) q.set('task_identifier', f.task_identifier.trim());
    if (f.dead_at_from) q.set('dead_at_from', f.dead_at_from);
    if (f.dead_at_to) q.set('dead_at_to', f.dead_at_to);
    router.push(`/platform/dead-letters?${q.toString()}`);
  };
  return (
    <form onSubmit={apply} aria-label="Dead letter filters" className="lims-filter-bar">
      <SelectInput label="State" value={f.state} onChange={set('state')} options={DEAD_LETTER_STATES.map((s) => ({ value: s, label: STATE_LABEL[s] ?? s }))} />
      <CheckboxInput label="Platform tasks only" checked={f.platform_rows} onChange={(c) => setF((p) => ({ ...p, platform_rows: c, tenant_id: c ? '' : p.tenant_id }))} />
      <SelectInput label="Tenant" value={f.platform_rows ? '' : f.tenant_id} onChange={set('tenant_id')} disabled={f.platform_rows} placeholder="All tenants"
        options={tenants.map((t) => ({ value: t.tenant_id, label: t.code }))} />
      <TextInput label="Task" value={f.task_identifier} onChange={set('task_identifier')} maxLength={200} />
      <TextInput label="Dead at from" type="date" value={f.dead_at_from} onChange={set('dead_at_from')} />
      <TextInput label="Dead at to" type="date" value={f.dead_at_to} onChange={set('dead_at_to')} />
      <Button type="submit">Apply filters</Button>
    </form>
  );
}

export function DeadLetterTable({ rows, tenants }: { rows: readonly DeadLetter[]; tenants: readonly TenantRef[] }) {
  const codeOf = (id: string | undefined) => (id ? tenants.find((t) => t.tenant_id === id)?.code ?? id : 'Platform');
  const columns: readonly ColumnDef<DeadLetter>[] = [
    { id: 'dead_at', header: 'Dead at', isRowHeader: true, cell: (d) => <a href={`/platform/dead-letters/${d.id}`}>{fmtDateTime(d.dead_at)}</a> },
    { id: 'tenant', header: 'Tenant', cell: (d) => codeOf(d.tenant_id) },
    { id: 'task', header: 'Task', cell: (d) => d.task_identifier },
    { id: 'attempts', header: 'Attempts', cell: (d) => String(d.attempts), align: 'end' },
    { id: 'code', header: 'Last error code', cell: (d) => d.last_error_code },
    { id: 'state', header: 'State', cell: (d) => <StatusChip kind="dead_letter" status={d.state} /> },
  ];
  return <DataTable caption="Dead letters" columns={columns} rows={rows} getRowId={(d) => d.id} emptyState={{ title: 'No dead letters yet' }} />;
}

export function DeadLetterDetail({ row, tenantCode }: { row: DeadLetter; tenantCode: string }) {
  const router = useRouter();
  const toast = useToast();
  const { run, pending } = useSingleFlight();
  const { handle, dialogs } = useProblemDialogs();
  const [op, setOp] = useState<'replay' | 'discard' | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();

  const submit = () => run(async () => {
    if (!op) return;
    const note = text.trim();
    if (op === 'discard' && !note) return setError('Enter a reason (up to 500 characters).');
    setError(undefined);
    const r = await resolveDeadLetterAction(row.id, op, row.version, note || undefined);
    if (r.ok) {
      setOp(null);
      toast.show({ tone: 'success', title: op === 'replay' ? 'Job queued again' : 'Dead letter discarded' });
      router.refresh();
      return;
    }
    const inline = handle(r);
    if (inline === undefined) setOp(null);
    else setError(inline);
  });
  const open = (o: 'replay' | 'discard') => { setText(''); setError(undefined); setOp(o); };

  const kv: [string, string][] = [
    ['Task', row.task_identifier], ['Tenant', tenantCode], ['Attempts', String(row.attempts)], ['First failed at', fmtDateTime(row.first_failed_at)],
    ['Dead at', fmtDateTime(row.dead_at)], ['Last error code', row.last_error_code], ['Error message (redacted)', row.last_error_message_redacted],
  ];
  if (row.resolved_by) kv.push(['Resolved by', row.resolved_by]);
  if (row.resolved_at) kv.push(['Resolved at', fmtDateTime(row.resolved_at)]);
  if (row.resolution_note) kv.push(['Resolution note', row.resolution_note]);

  return (
    <div className="lims-stack">
      <p>State: <StatusChip kind="dead_letter" status={row.state} /></p>
      <dl className="lims-kv">
        {kv.map(([k, v]) => <div key={k}><dt>{k}</dt> <dd>{v}</dd></div>)}
      </dl>
      {row.state === 'open' ? (
        <div className="lims-actions">
          <Button variant="primary" onPress={() => open('replay')}>Replay</Button>{' '}
          <Button variant="danger" onPress={() => open('discard')}>Discard</Button>
        </div>
      ) : null}
      <Dialog title={op === 'discard' ? 'Discard dead letter' : 'Replay dead letter'} isOpen={op !== null} onClose={() => setOp(null)}
        footer={<Button variant={op === 'discard' ? 'danger' : 'primary'} isLoading={pending} onPress={() => void submit()}>{op === 'discard' ? 'Discard' : 'Replay'}</Button>}>
        {op === 'discard'
          ? <TextAreaInput label="Reason" value={text} onChange={setText} maxLength={500} required />
          : <TextAreaInput label="Note (optional)" value={text} onChange={setText} maxLength={500} />}
        <Alert>{error}</Alert>
      </Dialog>
      {dialogs}
    </div>
  );
}
