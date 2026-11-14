'use client';
// SCR-02 Agent detail (04-UI-UX §3). Renders only documented DTO fields: credentials show metadata, never a secret or hash (AC-16.3).
import { useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { CodeBlock } from '@lims/ui/components/CodeBlock';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { DateText } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { Timeline } from '@lims/ui/components/Timeline';
import type { Agent, AgentCommand, AgentCredential, HealthTransition, InstrumentSummary } from '../server/types';
import { getAgentLogBundleAction, listAgentCommandsAction } from '../server/actions';
import { AgentActions } from './AgentActions';
import { AgentStatusChip, DEFAULT_CLOCK_OFFSET_WARN_SECONDS, HealthChip, InstrumentStateChip, hasPerm, healthLabel } from './labels';
import { IssueEnrolmentCode } from './IssueEnrolmentCode';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'health', label: 'Health history' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'commands', label: 'Commands & logs' },
] as const;
const DAY_MS = 86_400_000;
const UPDATE_WARN = new Set(['verify_failed', 'rolled_back']);

const when = (v: string | undefined) => (v ? <DateText value={v as never} withTime /> : '—');
const txt = (v: string | number | undefined) => (v === undefined ? '—' : String(v));

const KIND: Record<AgentCredential['kind'], string> = { enrolment_code: 'Enrolment code', device_token: 'Device token' };
// Explicit cells only: extra fields on a credential object are never rendered.
const credentialColumns: ColumnDef<AgentCredential>[] = [
  { id: 'kind', header: 'Kind', isRowHeader: true, cell: (c) => KIND[c.kind] ?? c.kind },
  { id: 'status', header: 'Status', cell: (c) => c.status },
  { id: 'issued_at', header: 'Issued at', cell: (c) => when(c.issued_at) },
  { id: 'issued_by', header: 'Issued by', cell: (c) => c.issued_by_display },
  { id: 'expires_at', header: 'Expires', cell: (c) => when(c.expires_at) },
  { id: 'used', header: 'Used / last used', cell: (c) => when(c.last_used_at ?? c.used_at) },
  { id: 'revoked_at', header: 'Revoked at', cell: (c) => when(c.revoked_at) },
];
const instrumentColumns: ColumnDef<InstrumentSummary>[] = [
  { id: 'code', header: 'Instrument code', isRowHeader: true, cell: (i) => <a className="lims-link" href={`/instruments/instruments/${i.id}`}>{i.instrument_code}</a> },
  { id: 'state', header: 'State', cell: (i) => <InstrumentStateChip state={i.state} /> },
  { id: 'link', header: 'Link state', cell: (i) => txt(i.link_state) },
  { id: 'last_message', header: 'Last message', cell: (i) => when(i.last_message_at) },
  { id: 'last_error', header: 'Last error code', cell: (i) => txt(i.last_link_error_code) },
  { id: 'silence', header: 'Silence status', cell: (i) => (i.silent_since ? <>Silent since {when(i.silent_since)}</> : 'Not silent') }, // [CONV] texts
];
const COMMAND_LABEL: Record<AgentCommand['kind'], string> = { upload_logs: 'Upload logs', refresh_config: 'Refresh configuration', restart_service: 'Restart service', reupload_since: 'Re-upload since…' };
const commandColumns: ColumnDef<AgentCommand>[] = [
  { id: 'kind', header: 'Kind', isRowHeader: true, cell: (c) => COMMAND_LABEL[c.kind] ?? c.kind },
  { id: 'state', header: 'State', cell: (c) => c.state },
  { id: 'requested', header: 'Requested by / at', cell: (c) => <>{txt(c.requested_by_display)} · {when(c.requested_at)}</> },
  { id: 'completed_at', header: 'Completed at', cell: (c) => when(c.completed_at) },
  { id: 'result', header: 'Result', cell: (c) => txt(c.result_code) },
];
const hasLog = (c: AgentCommand) => c.kind === 'upload_logs' && c.state === 'completed' && !!c.log_bundle_id;

export function AgentDetail({ agent, transitions, instruments, permissions, clockOffsetWarnSeconds = DEFAULT_CLOCK_OFFSET_WARN_SECONDS }: { agent: Agent; transitions: readonly HealthTransition[]; instruments: readonly InstrumentSummary[]; permissions: readonly string[]; clockOffsetWarnSeconds?: number }) {
  const [tab, setTab] = useState<string>('overview');
  const [commands, setCommands] = useState<{ rows: readonly AgentCommand[]; error?: string } | undefined>();
  const [log, setLog] = useState<{ bundleId: string; lines?: readonly string[]; error?: string } | undefined>();
  const h = agent.health;
  const canManage = hasPerm(permissions, 'instruments.agent.manage');
  const ipChangedRecently = !!h.last_ip_changed_at && Date.now() - Date.parse(h.last_ip_changed_at) < DAY_MS; // [CONV] 24 h
  const offsetSeconds = h.clock_offset_ms !== undefined ? h.clock_offset_ms / 1000 : h.clock_offset_seconds;
  const clockOff = offsetSeconds !== undefined && Math.abs(offsetSeconds) > clockOffsetWarnSeconds;

  const loadCommands = async () => {
    try {
      const r = await listAgentCommandsAction(agent.id);
      setCommands(r.ok ? { rows: r.data } : { rows: [], error: r.code });
    } catch {
      setCommands({ rows: [], error: 'common.internal' });
    }
  };
  const openLog = async (bundleId: string) => {
    setLog({ bundleId });
    try {
      const r = await getAgentLogBundleAction(agent.id, bundleId);
      setLog(r.ok ? { bundleId, lines: r.data.lines } : { bundleId, error: r.code });
    } catch {
      setLog({ bundleId, error: 'common.internal' });
    }
  };
  // "View log" only for manage (E20 needs instruments.agent.manage) on completed upload_logs with a bundle (04-UI-UX SCR-02).
  const cmdColumns: ColumnDef<AgentCommand>[] = canManage
    ? [...commandColumns, { id: 'log', header: 'Log', cell: (c) => (hasLog(c) ? <Button variant="secondary" onPress={() => void openLog(c.log_bundle_id!)}>View log</Button> : '—') }]
    : commandColumns;
  const selectTab = (id: string) => {
    setTab(id);
    if (id === 'commands') void loadCommands();
  };

  return (
    <section aria-label={`Agent ${agent.agent_code}`}>
      <PageHeader
        title={`${agent.agent_code} — ${agent.display_name}`}
        helpKey="instruments.agents"
        breadcrumbs={[{ label: 'Agents', href: '/instruments/agents' }, { label: agent.agent_code }]}
        status={
          <>
            <HealthChip state={h.state} /> <AgentStatusChip status={agent.status} />
          </>
        }
        actions={
          canManage ? (
            <>
              <IssueEnrolmentCode agentId={agent.id} queueDepth={h.queue_depth} />
              <AgentActions agent={agent} instruments={instruments} onCommandRequested={() => (tab === 'commands' ? void loadCommands() : undefined)} />
            </>
          ) : null
        }
      />
      {agent.status === 'revoked' ? <Banner tone="warning" title="This agent's access was revoked. It keeps messages locally until it is re-enrolled." /> : null}
      {h.config_state && h.config_state !== 'ok' ? (
        <Banner tone="warning" title={`The agent rejected configuration version ${agent.latest_config_version}: ${h.config_state}. Contact support.`} />
      ) : null}
      {h.update_state && UPDATE_WARN.has(h.update_state) ? (
        <Banner tone="warning" title={`The agent update${h.update_target_version ? ` to ${h.update_target_version}` : ''} did not complete: ${h.update_state}. The previous version keeps running.`} /> // [CONV] text
      ) : null}
      {clockOff ? <Banner tone="warning" title={`This PC's clock is off by ${Math.round(offsetSeconds!)} s. Fix the PC's date and time.`} /> /* [CONV] text */ : null}
      {ipChangedRecently ? <Banner tone="warning" title="This agent's network address changed recently. If you didn't move the PC, revoke it." /> : null}
      <Tabs items={TABS} selectedId={tab} onChange={selectTab} aria-label="Agent sections">
        {tab === 'overview' ? (
          <DescriptionList
            columns={3}
            items={[
              { term: 'Centre', value: agent.centre_id },
              { term: 'Status', value: <AgentStatusChip status={agent.status} /> },
              { term: 'Enrolled at', value: when(agent.enrolled_at) },
              { term: 'Last heartbeat', value: when(h.last_heartbeat_at) },
              { term: 'Agent / launcher / OS version', value: `${txt(h.agent_version)} / ${txt(h.launcher_version)} / ${txt(h.os_version)}` },
              { term: 'Queue (pending / rejected / oversize)', value: `${h.queue_depth} / ${txt(h.queue_rejected)} / ${txt(h.queue_oversize)}` },
              { term: 'Oldest pending age', value: `${h.oldest_pending_age_seconds} s` },
              { term: 'Disk free', value: h.disk_free_mb === undefined ? '—' : `${h.disk_free_mb} MB` },
              { term: 'Clock offset', value: h.clock_offset_ms === undefined ? txt(h.clock_offset_seconds === undefined ? undefined : `${h.clock_offset_seconds} s`) : `${h.clock_offset_ms} ms ± ${txt(h.clock_offset_uncertainty_ms)} ms` },
              { term: 'Config version (applied / latest)', value: `${txt(h.config_version_applied)} / ${agent.latest_config_version} (${txt(h.config_state)})` },
              { term: 'Update', value: `${txt(h.update_state)}${h.update_target_version ? ` → ${h.update_target_version}` : ''}` },
              { term: 'Update channel', value: agent.pinned_release_id ? `${agent.update_channel} (pinned)` : agent.update_channel },
              { term: 'Auth state', value: txt(h.auth_state) },
              { term: 'Last IP', value: txt(h.last_ip) },
            ]}
          />
        ) : tab === 'instruments' ? (
          <DataTable caption="Instruments on this agent" columns={instrumentColumns} rows={instruments} getRowId={(i) => i.id} emptyState={{ title: 'No instruments on this agent.' }} />
        ) : tab === 'health' ? (
          <Timeline items={transitions.slice(0, 50).map((t) => ({ at: t.changed_at, label: `${healthLabel(t.from_state)} → ${healthLabel(t.to_state)}` }))} />
        ) : tab === 'credentials' ? (
          <DataTable caption="Credentials" columns={credentialColumns} rows={agent.credentials} getRowId={(c) => c.credential_id} emptyState={{ title: 'No credentials issued yet.' }} />
        ) : (
          <DataTable
            caption="Commands"
            columns={cmdColumns}
            rows={commands?.rows ?? []}
            getRowId={(c) => c.command_id ?? `${c.kind}-${c.requested_at}`}
            {...(commands?.error ? { error: { title: 'Could not load commands', onRetry: () => void loadCommands() } } : {})}
            emptyState={{ title: commands ? 'No commands requested yet.' : 'Loading commands…' }} // [CONV] kit isLoading skeleton fails axe empty-table-header
          />
        )}
      </Tabs>
      <Drawer title="Agent log" width="lg" isOpen={!!log} onClose={() => setLog(undefined)}>
        {log?.error ? (
          <Banner tone="danger" title="Could not load the log">{log.error}</Banner>
        ) : log?.lines ? (
          <CodeBlock label="Agent log" text={log.lines.join('\n')} allowCopy />
        ) : (
          <p>Loading log…</p>
        )}
      </Drawer>
    </section>
  );
}
