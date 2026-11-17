// 04-UI-UX §2.6 Template editor (staff.reporting.template).
import { TemplateEditor } from '@/features/reporting/components/TemplateEditor';
import { gate } from '@/features/reporting/server/gate.server';
import { getReportTemplate } from '@/features/reporting/server/read.server';

export default async function TemplateEditorPage({ params }: { params: Promise<{ template_id: string }> }) {
  const { template_id } = await params;
  return gate('reporting.template.manage', async (permissions) => <TemplateEditor template={await getReportTemplate(template_id)} permissions={permissions} />);
}
