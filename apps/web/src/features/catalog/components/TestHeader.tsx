'use client';
// SCR-06 header: code · name with a text status badge (AC-02.7: a deactivated test still renders, marked Inactive).
// T0D-UIGUARD-1-CATALOG (LD-353 rule 1, LD-436): the kit PageHeader draws the h1; the status badge sits in its status slot.
import { Badge } from '@lims/ui/components/Badge';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { TestDto } from '../server/types';

export function TestHeader({ test }: { test: Pick<TestDto, 'code' | 'name' | 'is_active'> }) {
  return (
    <PageHeader
      title={`${test.code} · ${test.name}`}
      helpKey="catalog.tests"
      status={<Badge tone={test.is_active ? 'success' : 'neutral'}>{test.is_active ? 'Active' : 'Inactive'}</Badge>}
    />
  );
}
