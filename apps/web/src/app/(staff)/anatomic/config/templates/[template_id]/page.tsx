// 04-UI-UX §4.7 Synoptic template editor: server component via the BFF. The id is a UUID or the literal "new" (blank builder); anything else is notFound() before any API call
// (REQ-SEC-026/027). 404 / 400 → notFound(); no anatomic.config.manage or 403 → no-access state; other failures reject to error.tsx. LD-140 (2026-11-13): kit components only.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { ConfigForbidden } from '@/features/anatomic/components/config/config-shared';
import { TemplateEditor } from '@/features/anatomic/components/config/TemplateEditor';
import { getSynoptic } from '@/features/anatomic/server/config.server';
import { isUuid, orForbidden, orMissing } from '@/features/anatomic/server/shared';

export default async function TemplatePage({ params }: { params: Promise<{ template_id: string }> }) {
  const { template_id } = await params;
  const isNew = template_id === 'new';
  if (!isNew && !isUuid(template_id)) notFound();
  const session = await getShellSession();
  if (!(session?.actor.permissions ?? []).includes('anatomic.config.manage')) return <ConfigForbidden />;
  if (isNew) return <TemplateEditor />;
  const found = await orForbidden(() => orMissing(() => getSynoptic(template_id)));
  if (found === null) return <ConfigForbidden />;
  if (found === undefined) notFound();
  return <TemplateEditor template={found} />;
}
