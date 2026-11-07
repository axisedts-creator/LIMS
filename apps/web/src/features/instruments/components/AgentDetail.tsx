'use client';
// SCR-02 Agent detail (04-UI-UX §3). Renders only documented DTO fields: credentials show metadata, never a secret or hash (AC-16.3).
import { useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { Timeline } from '@lims/ui/components/Timeline';
import type { Agent, AgentCredential, HealthTransition, InstrumentSummary } from '../server/types';
import { AgentStatusChip, HealthChip, InstrumentStateChip, hasPerm, healthLabel } from './labels';
import { IssueEnrolmentCode } from './IssueEnrolmentCode';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'health', label: 'Health history' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'commands', label: 'Commands & logs' },
] as const;
const DAY_MS = 86_400_000;

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
];

export function AgentDetail({ agent, transitions, instruments, permissions }: { agent: Agent; transitions: readonly HealthTransition[]; instruments: readonly InstrumentSummary[]; permissions: readonly string[] }) {
  const [tab, setTab] = useState<string>('overview');
  const h = agent.health;
  const canManage = hasPerm(permissions, 'instruments.agent.manage');
  const ipChangedRecently = !!h.last_ip_changed_at && Date.now() - Date.parse(h.last_ip_changed_at) < DAY_MS; // [CONV] 24 h

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
              {/* ponytail: command/revoke/retire/edit dialogs not wired yet (no tests, open point in WEB-T02-impl.md) */}
              <Button isDisabled>Request command</Button>
              <Button variant="danger" isDisabled>Revoke</Button>
              <Button variant="danger" isDisabled>Retire</Button>
              <Button isDisabled>Edit</Button>
            </>
          ) : null
        }
      />
      {agent.status === 'revoked' ? <Banner tone="warning" title="This agent's access was revoked. It keeps messages locally until it is re-enrolled." /> : null}
      {h.config_state && h.config_state !== 'ok' ? (
        <Banner tone="warning" title={`The agent rejected configuration version ${agent.latest_config_version}: ${h.config_state}. Contact support.`} />
      ) : null}
      {ipChangedRecently ? <Banner tone="warning" title="This agent's network address changed recently. If you didn't move the PC, revoke it." /> : null}
      <Tabs items={TABS} selectedId={tab} onChange={setTab} aria-label="Agent sections">
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
          <p className="lims-description">Commands and log bundles appear here once requested.</p>
        )}
      </Tabs>
    </section>
  );
}
