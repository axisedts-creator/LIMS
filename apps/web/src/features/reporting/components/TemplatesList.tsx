'use client';
// 04-UI-UX §2.6 Report templates list (reporting.template.manage).
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { ReportTemplateRow } from '../server/types';
import { humanize } from './format';
import { SimpleTable, type Col } from './SimpleTable';

export function TemplatesList({ templates }: { templates: readonly ReportTemplateRow[]; permissions: readonly string[] }) {
  const columns: Col<ReportTemplateRow>[] = [
    { id: 'name', header: 'Name', rowHeader: true, cell: (t) => <a className="lims-link" href={`/reporting/templates/${t.id}`}>{t.name}</a> },
    { id: 'family', header: 'Family', cell: (t) => humanize(t.family) },
    { id: 'published', header: 'Published version', cell: (t) => (t.current_version_no ? `v${t.current_version_no}` : '—') },
    { id: 'draft', header: 'Draft', cell: (t) => (t.draft_version_no ? `v${t.draft_version_no}` : '—') },
    { id: 'active', header: 'Active', cell: (t) => (t.is_active ? 'Yes' : 'No') },
  ];
  return (
    <section aria-label="Report templates">
      <PageHeader title="Report templates" helpKey="reporting.templates" />
      <SimpleTable caption="Report templates" columns={columns} rows={templates} getRowId={(t) => t.id} empty={{ title: 'No report templates yet.' }} />
    </section>
  );
}
