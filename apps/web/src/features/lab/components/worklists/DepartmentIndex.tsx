'use client';
// /lab/worklists (C5 04-UI-UX §1 + §3.4 picker, route staff.lab.worklists, lab.worklist.read). LD-255 (FOUNDER): lab staff and the administrator reach the department worklists from the menu.
// One link per active department to the existing /lab/worklists/{department_id}. The spec's per-department counts (open, urgent) have no operation in lab.yaml: listed as a gap in the task notes.
import Link from 'next/link';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { DepartmentRow } from '../../server/adminpages.server';

export function DepartmentIndex({ departments }: { departments: readonly DepartmentRow[] }) {
  return (
    <section aria-label="Worklists">
      <PageHeader title="Worklists" helpKey="lab.worklists" />
      {departments.length === 0 ? (
        <EmptyState title="No active departments." />
      ) : (
        <ul>
          {departments.map((d) => (
            <li key={d.id}><Link href={`/lab/worklists/${encodeURIComponent(d.id)}`}>{`${d.name} (${d.code})`}</Link></li>
          ))}
        </ul>
      )}
    </section>
  );
}
