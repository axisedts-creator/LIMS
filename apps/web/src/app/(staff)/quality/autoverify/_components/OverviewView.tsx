'use client';
// 04-UI-UX §2.7 Auto-verification overview + #37 New version (AC-10.1, AC-12.3). LD-140: @lims/ui only; one primary button per page; every status shows tone, icon and word.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { createVersionAction } from '../_lib/actions';
import { DASH, DECISIONS_HREF, statusOf, versionHref } from '../_lib/format';
import type { RuleSet, Settings, VersionSummary } from '../_lib/types';
import { NativeSelect, NoticeBanner, useWrite } from './shared';
import { t } from '@/core/i18n/messages';

type Iso = DateTextProps['value'];
const rules = (n: number) => `${n} ${n === 1 ? 'rule' : 'rules'}`;
const when = (iso: string | undefined) => (iso ? <DateText value={iso as Iso} withTime /> : DASH);
const chip = (s: string) => { const x = statusOf(s); return <StatusChip kind="generic" status={s} label={x.label} tone={x.tone} />; };
const by = (name: string | undefined, at: string | undefined) => (name ? <>{name} · {when(at)}</> : DASH);

export function OverviewView({ ruleSet, settings, canManage }: { ruleSet: RuleSet | null; settings: Settings | undefined; canManage: boolean }) {
  const [creating, setCreating] = useState(0);
  const versions = ruleSet?.versions ?? [];
  const active = versions.find((v) => v.id === ruleSet?.active_version_id);
  const simulating = versions.find((v) => v.id === ruleSet?.simulating_version_id);

  const columns: ColumnDef<VersionSummary>[] = [
    { id: 'version', header: 'Version', isRowHeader: true, cell: (v) => <a href={versionHref(v.id)}>{`Version ${v.version_no}`}</a> },
    { id: 'status', header: 'Status', cell: (v) => chip(v.status) },
    { id: 'rules', header: 'Rules', align: 'end', cell: (v) => String(v.rule_count) },
    { id: 'created', header: 'Created by', cell: (v) => by(v.created_by_display, v.created_at) },
    { id: 'period', header: 'Simulation period', cell: (v) => (v.simulation_started_at ? <>{when(v.simulation_started_at)} – {when(v.simulation_stopped_at)}</> : DASH) },
    { id: 'activated', header: 'Activated by', cell: (v) => by(v.activated_by_display, v.activated_at) },
  ];

  return (
    <>
      <PageHeader
        title={t('quality.nav.autoverify')}
        helpKey="quality.autoverify"
        actions={<>
          <a className="lims-btn lims-btn-secondary" href={DECISIONS_HREF}>Decisions</a>
          {canManage ? <Button variant="primary" onPress={() => setCreating((n) => n + 1)}>New version</Button> : null}
        </>}
      />
      {settings ? (
        <Banner tone={settings.auto_verification_enabled ? 'success' : 'warning'} title={`Auto-verification is ${settings.auto_verification_enabled ? 'ON' : 'OFF'} for your lab (Admin › Tenant settings)`} />
      ) : null}
      {/* T0D-BUILD-5 (LD-455): getAutoverifyRuleSet 404 = no rule set yet -> the kit empty state. Auto-verification stays OFF by design; only "New version" (manage) stays. */}
      {ruleSet === null ? <EmptyState title="No auto-verification rules yet." body="Rules are written in a version. Auto-verification does nothing until a version is activated." /> : <>
      <Card title="Active version">
        {active ? (
          <>
            <p><a href={versionHref(active.id)}>{`Version ${active.version_no}`}</a> · {rules(active.rule_count)}{' '}</p>
            <DescriptionList items={[{ term: 'Activated by', value: by(active.activated_by_display, active.activated_at) }]} />
          </>
        ) : <p className="lims-description">No version is active. Auto-verification does nothing until one is activated.</p>}
      </Card>
      <Card title="Simulating version">
        {simulating ? (
          <>
            <p>{`Version ${simulating.version_no}`} · {rules(simulating.rule_count)}{' '}</p>
            <DescriptionList items={[{ term: 'Started', value: when(simulating.simulation_started_at) }]} />
            <a className="lims-btn lims-btn-secondary" href={versionHref(simulating.id)}>Open report</a>
          </>
        ) : <p className="lims-description">No version is simulating.</p>}
      </Card>
      <Card title="Versions">
        <DataTable<VersionSummary> columns={columns} rows={versions} getRowId={(v) => v.id} density="compact" caption="Versions" emptyState={{ title: 'No versions yet.', body: 'Create the first version to start writing rules.' }} />
      </Card>
      </>}
      {creating ? <NewVersionDialog key={creating} ruleSet={ruleSet} /> : null}
    </>
  );
}

type Source = 'active' | 'other' | 'empty';
/** #37: copy the active version, copy any version (a stopped one too, AC-11.4) or start empty: exactly one of copy_from_version_id / definition. */
function NewVersionDialog({ ruleSet }: { ruleSet: RuleSet | null }) {
  const router = useRouter();
  const w = useWrite();
  const [open, setOpen] = useState(true);
  const activeId = ruleSet?.active_version_id;
  const versions = ruleSet?.versions ?? [];
  const [source, setSource] = useState<Source>(activeId ? 'active' : 'empty');
  const [other, setOther] = useState('');
  const copyFrom = source === 'active' ? (activeId ?? null) : source === 'other' ? other : null;
  const ready = source !== 'other' || other !== '';
  const create = () => w.run('create', JSON.stringify(copyFrom), (key) => createVersionAction(copyFrom, key), (v) => { setOpen(false); router.push(versionHref(v.id)); });

  return (
    <Dialog
      title="New version" isOpen={open} onClose={() => setOpen(false)} size="md"
      footer={<>
        <Button variant="ghost" onPress={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" isDisabled={!ready} isLoading={w.pending} onPress={() => void create()}>Create draft</Button>
      </>}
    >
      <NoticeBanner notice={w.notice} onReload={() => router.refresh()} />
      <RadioGroup<Source>
        label="Start from" name="source" value={source} onChange={(s) => { setSource(s); w.reset(); }}
        options={[
          { value: 'active', label: 'Copy the active version', isDisabled: !activeId },
          { value: 'other', label: 'Copy another version', isDisabled: !versions.length },
          { value: 'empty', label: 'Start empty' },
        ]}
      />
      {source === 'other' ? (
        <NativeSelect label="Version to copy" value={other} onChange={setOther} placeholder="Choose a version" options={versions.map((v) => ({ value: v.id, label: `Version ${v.version_no} (${statusOf(v.status).label})` }))} />
      ) : null}
    </Dialog>
  );
}
