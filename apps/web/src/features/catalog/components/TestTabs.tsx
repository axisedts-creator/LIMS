'use client';
// SCR-06…08 tab strip: the selected tab and analyte live in the URL (?tab=&analyte=), the content is rendered by the server page.
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Tabs } from '@lims/ui/components/Tabs';

export const TAB_IDS = ['analytes', 'general', 'ranges', 'critical'] as const;
export type TabId = (typeof TAB_IDS)[number];
const ITEMS = [
  { id: 'analytes', label: 'Analytes' },
  { id: 'general', label: 'General' },
  { id: 'ranges', label: 'Reference ranges' },
  { id: 'critical', label: 'Critical limits' },
] as const;

export function TestTabs({ testId, tab, analyteId, children }: { testId: string; tab: TabId; analyteId?: string | undefined; children: ReactNode }) {
  const router = useRouter();
  return (
    <Tabs
      aria-label="Test sections"
      items={ITEMS}
      selectedId={tab}
      onChange={(id) => router.push(`/catalog/tests/${testId}?tab=${id}${analyteId && (id === 'ranges' || id === 'critical' || id === 'analytes') ? `&analyte=${analyteId}` : ''}`)}
    >
      {children}
    </Tabs>
  );
}
