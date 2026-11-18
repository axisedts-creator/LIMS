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

import { VerificationPolicyTab } from './VerificationPolicyTab';

const TABS = [{ id: 'general', label: 'General' }, { id: 'delta', label: 'Delta rules' }, { id: 'codes', label: 'Reason codes' }, { id: 'holds', label: 'QC holds' }] as const;   // T-25: QC holds
const VERIFY_TAB = { id: 'verification', label: 'Verification levels' } as const; // T0D-VERLEVEL-1 (LD-316): shown with lab.verification_policy.read or .manage

export function LabSettingsPage({ permissions }: { permissions: readonly string[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id'] | typeof VERIFY_TAB.id>('general');
  const canManage = permissions.includes('lab.config.manage');
  const canManagePolicy = permissions.includes('lab.verification_policy.manage'); // lab.config.manage does NOT edit the policy
  const items = canManagePolicy || permissions.includes('lab.verification_policy.read') ? [...TABS, VERIFY_TAB] : TABS;
  return (
    <section aria-label="Lab settings">
      <PageHeader title="Lab settings" helpKey="lab.settings" />
      <Tabs items={items} selectedId={tab} onChange={(id) => setTab(id as typeof tab)} aria-label="Settings sections">
        {tab === 'general' ? <GeneralTab canManage={canManage} /> : tab === 'delta' ? <DeltaRulesTab canManage={canManage} /> : tab === 'codes' ? <ReasonCodesTab canManage={canManage} /> : tab === 'verification' ? <VerificationPolicyTab canManage={canManagePolicy} /> : <QcHoldsTab canRelease={permissions.includes('lab.qc_hold.release')} />}
      </Tabs>
    </section>
  );
}
