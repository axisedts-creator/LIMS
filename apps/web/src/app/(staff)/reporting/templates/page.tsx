// 04-UI-UX §2.6 Report templates list. No routes.yaml row for the list → self-guard (reporting.template.manage).
import { TemplatesList } from '@/features/reporting/components/TemplatesList';
import { gate } from '@/features/reporting/server/gate.server';
import { listReportTemplates } from '@/features/reporting/server/read.server';

export default async function TemplatesPage() {
  return gate('reporting.template.manage', async (permissions) => <TemplatesList templates={(await listReportTemplates()).data} permissions={permissions} />);
}
