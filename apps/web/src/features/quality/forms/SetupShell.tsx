'use client';
// C9 T-22 shell of the four set-up screens (04-UI-UX §2.6): PageHeader + kit Tabs (Materials / Maps / Plans / Targets). The PageShell itself comes from the (staff) layout.
// LD-140: kit components only. Each tab is its own route, so changing tab navigates; the in-app help page of a tab is `quality.setup_<tab>` (help/setup_<tab>.md).
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';

export type SetupTab = 'materials' | 'maps' | 'plans' | 'targets';
const ITEMS = [
  { id: 'materials', label: 'Materials' },
  { id: 'maps', label: 'Maps' },
  { id: 'plans', label: 'Plans' },
  { id: 'targets', label: 'Targets' },
] as const;

export function SetupShell({ active, actions, children }: { active: SetupTab; actions?: ReactNode; children: ReactNode }) {
  const router = useRouter();
  return (
    <>
      <PageHeader title="QC set-up" helpKey={`quality.setup_${active}`} {...(actions ? { actions } : {})} />
      <Tabs items={ITEMS} selectedId={active} aria-label="Set-up sections" onChange={(id) => router.push(`/quality/setup/${id}`)}>
        {children}
      </Tabs>
    </>
  );
}
