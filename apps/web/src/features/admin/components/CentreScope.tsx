'use client';
// Centre access block shared by AD-2 and AD-3: All/Selected radios, Centres + Branches pickers, D-13 hub-lab warning (never blocks saving).
import { Banner } from '@lims/ui/components/Banner';
import { HUB_USER_COPY, type Branch, type Centre } from '../lib';
import { Picker, Radios } from '../ui';

export interface Scope { all: boolean; centres: string[]; branches: string[] }

export function CentreScope({ scope, onChange, centres, branches, hubLab, centresError, ids, disabled }: {
  scope: Scope; onChange: (s: Scope) => void; centres: readonly Centre[]; branches: readonly Branch[]; hubLab: boolean; centresError?: string | undefined;
  ids?: { centres?: string; branches?: string }; disabled?: boolean;
}) {
  const branchName = new Map(branches.map((b) => [b.branch_id, b.name]));
  return (
    <>
      <Radios legend="Centre access" name="centre-access" value={scope.all ? 'all' : 'selected'} disabled={disabled}
        options={[{ value: 'all', label: 'All centres' }, { value: 'selected', label: 'Selected centres' }]}
        onChange={(v) => onChange({ ...scope, all: v === 'all' })} />
      {hubLab && !scope.all ? <Banner tone="warning" title={HUB_USER_COPY} /> : null}
      {!scope.all ? (
        <Picker label="Centres" multiple value={scope.centres} onChange={(c) => onChange({ ...scope, centres: c })} error={centresError} disabled={disabled}
          {...(ids?.centres ? { id: ids.centres } : {})}
          options={centres.filter((c) => c.is_active).map((c) => ({ value: c.centre_id, label: c.name, tag: branchName.get(c.branch_id) }))} />
      ) : null}
      <Picker label="Branches" multiple value={scope.branches} onChange={(b) => onChange({ ...scope, branches: b })} disabled={disabled}
        {...(ids?.branches ? { id: ids.branches } : {})}
        options={branches.filter((b) => b.is_active).map((b) => ({ value: b.branch_id, label: b.name }))} />
    </>
  );
}
