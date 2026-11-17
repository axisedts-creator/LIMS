'use client';
// SCR-01 Agents (04-UI-UX §3) + New agent dialog → E11. Manage affordances are a UI hint; the API enforces.
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createAgentAction } from '../server/actions';
import { AGENT_CODE_RE, parseAgentQuery, type AgentSummary, type UpdateChannel } from '../server/types';
import { AgentStatusChip, DEFAULT_CLOCK_OFFSET_WARN_SECONDS, HEALTH_OPTIONS, HealthChip, STATUS_OPTIONS, hasPerm } from './labels';

export interface Centre { id: string; name: string }

const POLL_MS = 30_000; // 04-UI-UX SCR-01 auto-refresh [CONV]

export function AgentsList({ agents, permissions, centres, workingCentreId, clockOffsetWarnSeconds = DEFAULT_CLOCK_OFFSET_WARN_SECONDS }: { agents: readonly AgentSummary[]; permissions: readonly string[]; centres: readonly Centre[]; workingCentreId?: string; clockOffsetWarnSeconds?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [creating, setCreating] = useState(false);
  const canManage = hasPerm(permissions, 'instruments.agent.manage');
  const centreName = new Map(centres.map((c) => [c.id, c.name]));
  const q = parseAgentQuery(Object.fromEntries(searchParams.entries()));

  // Poll through the BFF (router.refresh re-runs the server component); skipped while the tab is hidden.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [router]);

  const navigate = (next: { centre_id?: string | undefined; status?: readonly string[] | undefined; health_state?: readonly string[] | undefined; sort?: string }) => {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      const s = Array.isArray(v) ? v.join(',') : (v as string | undefined);
      if (s) p.set(k, s);
      else p.delete(k);
    }
    p.delete('cursor');
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const filterValue: FilterValue = { ...(q.centreId ? { centre_id: q.centreId } : {}), status: q.status, ...(q.healthState.length ? { health_state: q.healthState } : {}) };
  const offset = (s: number | undefined) => (s === undefined ? '—' : Math.abs(s) > clockOffsetWarnSeconds ? `${s} s (clock off)` : `${s} s`); // [CONV] warning text

  const columns: ColumnDef<AgentSummary>[] = [
    { id: 'agent_code', header: 'Agent code', isRowHeader: true, sortKey: 'agent_code', cell: (a) => <a className="lims-link" href={`/instruments/agents/${a.id}`}>{a.agent_code}</a> },
    { id: 'name', header: 'Name', cell: (a) => a.display_name },
    { id: 'centre', header: 'Centre', cell: (a) => centreName.get(a.centre_id) ?? a.centre_id },
    { id: 'health', header: 'Health', cell: (a) => <HealthChip state={a.health.state} /> },
    { id: 'last_heartbeat', header: 'Last heartbeat', sortKey: 'last_heartbeat_at', cell: (a) => (a.health.last_heartbeat_at ? <DateText value={a.health.last_heartbeat_at as never} withTime /> : '—') },
    { id: 'version', header: 'Version', cell: (a) => a.health.agent_version ?? '—' },
    { id: 'queue', header: 'Queue', align: 'end', cell: (a) => String(a.health.queue_depth) },
    { id: 'clock_offset', header: 'Clock offset', align: 'end', cell: (a) => offset(a.health.clock_offset_seconds) },
    { id: 'status', header: 'Status', cell: (a) => <AgentStatusChip status={a.status} /> },
  ];

  return (
    <section aria-label="Agents">
      <PageHeader title="Agents" helpKey="instruments.agents" actions={canManage ? <Button variant="primary" onPress={() => setCreating(true)}>New agent</Button> : null} />
      <FilterBar
        filters={[
          { id: 'centre_id', label: 'Centre', kind: 'select', options: centres.map((c) => ({ value: c.id, label: c.name })) },
          { id: 'status', label: 'Status', kind: 'select', multiple: true, options: STATUS_OPTIONS },
          { id: 'health_state', label: 'Health', kind: 'select', multiple: true, options: HEALTH_OPTIONS },
        ]}
        value={filterValue}
        onChange={(v) => navigate({ centre_id: v.centre_id as string | undefined, status: v.status as readonly string[] | undefined, health_state: v.health_state as readonly string[] | undefined })}
        onReset={() => navigate({ centre_id: undefined, status: undefined, health_state: undefined })}
      />
      <DataTable
        caption="Agents"
        columns={columns}
        rows={agents}
        getRowId={(a) => a.id}
        sort={{ value: q.sort, onChange: (v) => navigate({ sort: v.includes('last_heartbeat_at') ? '-last_heartbeat_at' : 'agent_code' }) }}
        emptyState={{
          title: 'No agents yet. Create one for each lab PC that connects analysers.',
          ...(canManage ? { action: { label: 'New agent', onPress: () => setCreating(true) } } : {}),
        }}
      />
      {canManage && creating ? <NewAgentDialog centres={centres} workingCentreId={workingCentreId} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function NewAgentDialog({ centres, workingCentreId, onClose }: { centres: readonly Centre[]; workingCentreId: string | undefined; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [centreId, setCentreId] = useState<string | undefined>(workingCentreId);
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [threshold, setThreshold] = useState<number | undefined>();
  const [codeError, setCodeError] = useState<string>();
  const [centreError, setCentreError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  // One Idempotency-Key per dialog open: a retry after a failure is the same create (02-CONVENTIONS §4.5).
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const inFlight = useRef(false); // a second Ctrl+Enter before the response must not send a second POST
  const done = useRef(false); // after success, further presses must not create a second agent

  const submit = async () => {
    if (done.current || inFlight.current) return;
    const badCode = !AGENT_CODE_RE.test(code);
    setCodeError(badCode ? 'Use 2–32 capital letters, digits or hyphens.' : undefined); // [CONV]
    setCentreError(centreId ? undefined : 'Choose a centre.'); // [CONV]
    if (badCode || !centreId) return;
    inFlight.current = true;
    setFormError(undefined);
    try {
      const r = await createAgentAction(
        {
          agent_code: code,
          display_name: name,
          centre_id: centreId,
          update_channel: channel,
          ...(threshold !== undefined ? { backlog_threshold: threshold } : {}),
        },
        idempotencyKey,
      );
      if (r.ok) {
        done.current = true;
        onClose();
        toast.show({ tone: 'success', title: 'Agent created. Issue an enrolment code to install it.' });
        router.push(`/instruments/agents/${r.data.id}`);
      } else if (r.code === 'instruments.code_duplicate') {
        setCodeError('An agent with this code already exists.'); // [CONV]
      } else {
        setFormError(r.code); // inline: a toast behind the modal dialog is aria-hidden
      }
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <Dialog title="New agent" isOpen onClose={onClose} size="md">
      <Form onSubmit={submit}>
        {formError ? (
          <div role="alert">
            <Banner tone="danger" title="Could not create the agent">{formError}</Banner>
          </div>
        ) : null}
        <TextField
          label="Agent code"
          name="agent_code"
          maxLength={32}
          isRequired
          value={code}
          onChange={(v) => {
            setCode(v.toUpperCase());
            setCodeError(undefined);
          }}
          {...(codeError ? { error: codeError } : {})}
        />
        <TextField label="Name" name="display_name" maxLength={80} isRequired value={name} onChange={setName} />
        <Select
          label="Centre"
          name="centre_id"
          isRequired
          options={centres.map((c) => ({ value: c.id, label: c.name }))}
          {...(centreId ? { value: centreId } : {})}
          {...(centreError ? { error: centreError } : {})}
          onChange={(v) => {
            setCentreId(v);
            setCentreError(undefined);
          }}
        />
        <RadioGroup<UpdateChannel> label="Update channel" name="update_channel" value={channel} onChange={setChannel} orientation="horizontal" options={[{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }]} />
        <IntegerField label="Backlog threshold" name="backlog_threshold" min={10} max={100000} {...(threshold !== undefined ? { value: threshold } : {})} onChange={setThreshold} />
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Create agent</Button>
      </Form>
    </Dialog>
  );
}
