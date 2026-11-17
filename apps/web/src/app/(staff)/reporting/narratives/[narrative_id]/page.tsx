// 04-UI-UX §2.4 Narrative report editor (staff.reporting.narrative).
import { NarrativeEditor } from '@/features/reporting/components/NarrativeEditor';
import { gate } from '@/features/reporting/server/gate.server';
import { getNarrative, listNarrativeTemplates } from '@/features/reporting/server/read.server';

export default async function NarrativePage({ params }: { params: Promise<{ narrative_id: string }> }) {
  const { narrative_id } = await params;
  return gate('reporting.narrative.write', async (permissions) => {
    const narrative = await getNarrative(narrative_id);
    const templates = await listNarrativeTemplates(narrative.template_kind);
    return <NarrativeEditor narrative={narrative} templates={templates.data} permissions={permissions} />;
  });
}
