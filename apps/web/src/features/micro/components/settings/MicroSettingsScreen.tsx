'use client';
// 04-UI-UX §5 Micro settings: Dictionaries · Plating protocols · AST panels · Instrument mappings · General. All writes need micro.config.manage (UI hint; the API enforces);
// other users get the read-only view (buttons hidden). Tab data loads through server actions on first view of a tab. LD-140: masters are a list + right Drawer with Save.
import { useState } from 'react';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import type { MicroSettingsDto } from '../../server/types';
import { PERM } from '../common';
import { DictionariesTab } from './DictionariesTab';
import { GeneralTab } from './GeneralTab';
import { MappingsTab } from './MappingsTab';
import { PanelsTab } from './PanelsTab';
import { ProtocolsTab } from './ProtocolsTab';

const TABS = [{ id: 'dictionaries', label: 'Dictionaries' }, { id: 'protocols', label: 'Plating protocols' }, { id: 'panels', label: 'AST panels' }, { id: 'mappings', label: 'Instrument mappings' }, { id: 'general', label: 'General' }] as const;

export function MicroSettingsScreen({ settings, permissions }: { settings: MicroSettingsDto; permissions: readonly string[] }) {
  const [tab, setTab] = useState<string>('dictionaries');
  const canManage = permissions.includes(PERM.config);
  return (
    <section aria-label="Micro settings">
      <PageHeader title="Micro settings" helpKey="micro.settings" breadcrumbs={[{ label: 'Microbiology' }, { label: 'Settings' }]} />
      <Tabs items={TABS} selectedId={tab} onChange={setTab} aria-label="Settings sections">
        {tab === 'dictionaries' ? <DictionariesTab canManage={canManage} /> : null}
        {tab === 'protocols' ? <ProtocolsTab canManage={canManage} /> : null}
        {tab === 'panels' ? <PanelsTab canManage={canManage} /> : null}
        {tab === 'mappings' ? <MappingsTab canManage={canManage} /> : null}
        {tab === 'general' ? <GeneralTab settings={settings} canManage={canManage} /> : null}
      </Tabs>
    </section>
  );
}
