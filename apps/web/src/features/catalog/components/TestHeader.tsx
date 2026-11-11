'use client';
// SCR-06 header: code · name with a text status badge (AC-02.7: a deactivated test still renders, marked Inactive).
import { Badge } from '@lims/ui/components/Badge';
import type { TestDto } from '../server/types';

export function TestHeader({ test }: { test: Pick<TestDto, 'code' | 'name' | 'is_active'> }) {
  return (
    <div className="lims-page-header-row">
      <h1 className="lims-page-title">{`${test.code} · ${test.name}`}</h1>
      <Badge tone={test.is_active ? 'success' : 'neutral'}>{test.is_active ? 'Active' : 'Inactive'}</Badge>
    </div>
  );
}
