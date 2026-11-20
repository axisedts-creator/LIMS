'use client';
// /lab/worklists (C5 04-UI-UX §1 + §3.4 picker, route staff.lab.worklists, lab.worklist.read). LD-255 (FOUNDER): lab staff and the administrator reach the department worklists from the menu.
// One link per active department to the existing /lab/worklists/{department_id}. The spec's per-department counts (open, urgent) have no operation in lab.yaml: listed as a gap in the task notes.
// T0D-UILIST-1 (LD-353 template 1, rule 5): the departments are a table with its header row always drawn; an empty list is the EmptyState in the body.
import Link from 'next/link';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { DepartmentRow } from '../../server/adminpages.server';
import { t } from '@/core/i18n/messages';
import { ListTable } from '../shared';

const DEPARTMENT_COLUMNS = ['Department', 'Code'] as const;

export function DepartmentIndex({ departments }: { departments: readonly DepartmentRow[] }) {
  return (
    <section aria-label="Worklists">
      <PageHeader title={t('lab.nav.worklists')} helpKey="lab.worklists" />
      <ListTable caption="Departments" cols={2} empty="No active departments."
        head={DEPARTMENT_COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}
        rows={departments.map((d) => (
          <tr key={d.id}>
            <td><Link href={`/lab/worklists/${encodeURIComponent(d.id)}`}>{`${d.name} (${d.code})`}</Link></td>
            <td>{d.code}</td>
          </tr>
        ))} />
    </section>
  );
}
