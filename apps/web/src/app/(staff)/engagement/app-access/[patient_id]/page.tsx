// W8 Patient app access (C16 04-UI-UX W8; route staff.engagement.app_access). The permission floor is checked before any API call; without it → 404.
// Issue needs engagement.link.issue and revoke engagement.link.revoke; both are re-checked in server/link-actions.ts and by the API.
import { requirePerm } from '@/features/engagement/server/queue.server';
import { appAccessPage } from '@/features/engagement/server/link-pages';

export default async function AppAccessPage({ params }: { params: Promise<{ patient_id: string }> }) {
  await requirePerm('engagement.link.read');
  return appAccessPage((await params).patient_id);
}
