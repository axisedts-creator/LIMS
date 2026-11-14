// 04-UI-UX §4.2 Case workspace — server component via the BFF. A malformed id never reaches the API (REQ-SEC-026/027); 404/400 → notFound()
// (another tenant's or centre's case looks like a missing one); 403 → no-access state; other failures reject to error.tsx.
// LD-140 (2026-11-13): screens are built from the kit only (see CaseWorkspace).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { AnatomicForbidden } from '@/features/anatomic/components/AnatomicForbidden';
import { CaseWorkspace } from '@/features/anatomic/components/CaseWorkspace';
import { getCase, listGrossTemplates } from '@/features/anatomic/server/reads.server';
import { isUuid, orForbidden, orMissing } from '@/features/anatomic/server/shared';

export default async function CaseWorkspacePage({ params }: { params: Promise<{ case_id: string }> }) {
  const { case_id } = await params;
  if (!isUuid(case_id)) notFound();
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  const detail = await orForbidden(() => orMissing(() => getCase(case_id)));
  if (detail === null) return <AnatomicForbidden />;
  if (detail === undefined) notFound();
  // Templates are a convenience for the people who write gross text: a failing list never breaks the page.
  const templates = permissions.includes('anatomic.case.work') ? await listGrossTemplates().catch(() => []) : [];
  return <CaseWorkspace detail={detail} permissions={permissions} templates={templates} />;
}
