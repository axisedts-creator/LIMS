'use client';
// /lab/settings (04-UI-UX §1 nav row lab.config.manage CR-C5-004, §3.13): tabs General / Delta rules / Reason codes / QC holds (T-25).
// Every write control needs lab.config.manage; the API enforces it (S-15) — the UI only hides. The tabs read their own data, so a failing API never crashes the page.
import { useState } from 'react';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { DeltaRulesTab } from './DeltaRulesTab';
import { GeneralTab } from './GeneralTab';
import { QcHoldsTab } from './QcHoldsTab';
import { ReasonCodesTab } from './ReasonCodesTab';

const TABS = [{ id: 'general', label: 'General' }, { id: 'delta', label: 'Delta rules' }, { id: 'codes', label: 'Reason codes' }, { id: 'holds', label: 'QC holds' }] as const;   // T-25: QC holds

export function LabSettingsPage({ permissions }: { permissions: readonly string[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('general');
  const canManage = permissions.includes('lab.config.manage');
  return (
    <section aria-label="Lab settings">
      <PageHeader title="Lab settings" helpKey="lab.settings" />
      <Tabs items={TABS} selectedId={tab} onChange={(id) => setTab(id as typeof tab)} aria-label="Settings sections">
        {tab === 'general' ? <GeneralTab canManage={canManage} /> : tab === 'delta' ? <DeltaRulesTab canManage={canManage} /> : tab === 'codes' ? <ReasonCodesTab canManage={canManage} /> : <QcHoldsTab canRelease={permissions.includes('lab.qc_hold.release')} />}
      </Tabs>
    </section>
  );
}
