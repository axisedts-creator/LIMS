// 04-UI-UX §4.6 Batch detail — server component via the BFF. A malformed id never reaches the API (REQ-SEC-026/027); 404/400 → notFound() (another tenant's or
// centre's batch looks like a missing one); no anatomic.case.read or 403 → no-access state; other failures reject to error.tsx.
// LD-140 (2026-11-13): screens are built from the kit only (see BatchDetailScreen).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { AnatomicForbidden } from '@/features/anatomic/components/AnatomicForbidden';
import { BatchDetailScreen } from '@/features/anatomic/components/molecular/BatchDetailScreen';
import { getBatch } from '@/features/anatomic/server/molecular.server';
import { isUuid, orForbidden, orMissing } from '@/features/anatomic/server/shared';

export default async function BatchPage({ params }: { params: Promise<{ batch_id: string }> }) {
  const { batch_id } = await params;
  if (!isUuid(batch_id)) notFound();
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('anatomic.case.read')) return <AnatomicForbidden />;
  const batch = await orForbidden(() => orMissing(() => getBatch(batch_id)));
  if (batch === null) return <AnatomicForbidden />;
  if (batch === undefined) notFound();
  return <BatchDetailScreen batch={batch} canWork={permissions.includes('anatomic.case.work')} />;
}
