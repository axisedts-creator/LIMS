'use client';
// 04-UI-UX §4.7 Configuration "Pathology setup": PageHeader → Tabs (Settings · Stains · Test profiles · Assays · Coded lists · Synoptic templates · Text templates). The server page loaded
// only the active tab's data; choosing a tab pushes /anatomic/config?tab=<id>. LD-140 (2026-11-13, binding): kit components and token class names only; masters are a list with a
// right Drawer and per-section Save; one primary button per page; every status shows tone, icon and word.
// T0D-UISETTINGS-1 (LD-353 template 4): the tabs sit in the kit SettingsForm tabs slot on every tab; the Settings tab is the kit SettingsForm itself.
import { useRouter } from 'next/navigation';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import type { TabData } from '../../server/config.load.server';
import { AssaysTab } from './AssaysTab';
import { CodedListsTab } from './CodedListsTab';
import { SettingsTab } from './SettingsTab';
import { StainsTab } from './StainsTab';
import { TemplatesTab } from './TemplatesTab';
import { TestProfilesTab } from './TestProfilesTab';
import { TextTemplatesTab } from './TextTemplatesTab';

const TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'stains', label: 'Stains' },
  { id: 'test-profiles', label: 'Test profiles' },
  { id: 'assays', label: 'Assays' },
  { id: 'coded-lists', label: 'Coded lists' },
  { id: 'templates', label: 'Synoptic templates' },
  { id: 'text-templates', label: 'Text templates' },
] as const;

export function ConfigScreen({ data }: { data: TabData }) {
  const router = useRouter();
  const tabs = <Tabs items={TABS} selectedId={data.tab} onChange={(id) => router.push(`/anatomic/config?tab=${id}`)} aria-label="Pathology setup sections" />;
  return (
    <>
      <PageHeader title="Pathology setup" helpKey="anatomic.config" />
      {data.tab === 'settings' ? (
        <SettingsTab settings={data.settings} stains={data.stains} tabs={tabs} />
      ) : (
        // Master-list tabs keep their list and drawer; same tabs slot as the Settings form (kit .lims-settings classes).
        <div className="lims-settings">
          <div className="lims-settings-tabs">{tabs}</div>
          {data.tab === 'stains' ? <StainsTab stains={data.stains} /> : null}
          {data.tab === 'test-profiles' ? <TestProfilesTab profiles={data.profiles} tests={data.tests} stains={data.stains} templates={data.templates} /> : null}
          {data.tab === 'assays' ? <AssaysTab assays={data.assays} /> : null}
          {data.tab === 'coded-lists' ? <CodedListsTab set={data.set} rows={data.rows} /> : null}
          {data.tab === 'templates' ? <TemplatesTab templates={data.templates} /> : null}
          {data.tab === 'text-templates' ? <TextTemplatesTab items={data.items} /> : null}
        </div>
      )}
    </>
  );
}
