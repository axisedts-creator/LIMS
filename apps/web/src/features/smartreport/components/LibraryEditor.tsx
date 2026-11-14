'use client';
// SR-04 Library editor shell (04-UI-UX SR-04): six tabs, read-only unless draft, no-longer-draft banner with Reload.
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { NOT_DRAFT, statusText, type Block, type Group, type Mapping, type Option, type Rule, type Version } from '../library';
import { Ctx, failText, type EditorCtx } from './common';
import { SettingsTab } from './SettingsTab';
import { CheckTab, type Numbered } from './CheckTab';
import { TextsTab } from './TextsTab';
import { RulesTab } from './RulesTab';
import { GroupsTab, MappingTab } from './GroupsTab';

const TABS = [
  { id: 'settings', label: 'Settings & score' }, { id: 'groups', label: 'Body systems' }, { id: 'mapping', label: 'Analyte mapping' },
  { id: 'texts', label: 'Texts' }, { id: 'rules', label: 'Rules' }, { id: 'check', label: 'Check & submit' },
] as const;

/** `review` (SR-05) renders the same tabs read-only under the review panel (diff counts, Approve / Return). */
interface Props { version: Version; blocks: Block[]; rules: Rule[]; mappings: Mapping[]; groups: Group[]; organGroups: Option[]; canPreviewOrder: boolean; review?: ReactNode }

export function LibraryEditor({ version, blocks, rules, mappings, groups, organGroups, canPreviewOrder, review }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<string>('settings');
  const [notDraft, setNotDraft] = useState(false);
  const [issues, setIssues] = useState<Numbered[]>();
  const readOnly = !!review || version.status !== 'draft' || notDraft;
  const ctx: EditorCtx = {
    versionId: version.id, language: version.language === 'ne' ? 'ne' : 'en', readOnly,
    failed: (r) => { if (r.code === 'smartreport.library_invalid_transition') setNotDraft(true); return failText(r); },
    saved: () => { toast.show({ tone: 'success', title: 'Saved' }); router.refresh(); },
  };
  const groupName = (code?: string) => organGroups.find((o) => o.value === code)?.label ?? groups.find((g) => g.group_code === code)?.display_en ?? code ?? '—';

  return (
    <Ctx.Provider value={ctx}>
      <PageHeader title={`Library v${version.version_no}`} breadcrumbs={[{ label: 'Library', href: '/smartreport/library' }, { label: `v${version.version_no}` }]} helpKey="smartreport.library.editor" />
      {review}
      {version.status !== 'draft' && !review ? <Banner tone="info" title={`This version is ${statusText(version.status)}; create a new draft to change it.`} /> : null}
      {notDraft ? (
        <div role="alert"><Banner tone="warning" title={NOT_DRAFT} action={{ label: 'Reload', onPress: () => router.refresh() }} /></div>
      ) : null}
      <Tabs items={TABS} selectedId={tab} onChange={setTab} aria-label="Library sections">
        {tab === 'settings' ? <SettingsTab version={version} /> : null}
        {tab === 'groups' ? <GroupsTab groups={groups} /> : null}
        {tab === 'mapping' ? <MappingTab mappings={mappings} groupName={groupName} organGroups={organGroups} minMapped={Number(version.params?.['min_mapped_results'] ?? 0)} /> : null}
        {tab === 'texts' ? <TextsTab blocks={blocks} /> : null}
        {tab === 'rules' ? <RulesTab rules={rules} blocks={blocks} groupName={groupName} organGroups={organGroups} /> : null}
        {tab === 'check' ? <CheckTab version={version.version} onJump={setTab} issues={issues} setIssues={setIssues} canPreviewOrder={canPreviewOrder} /> : null}
      </Tabs>
    </Ctx.Provider>
  );
}
